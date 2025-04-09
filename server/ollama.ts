import Anthropic from '@anthropic-ai/sdk'
import {
  ContentBlockParam,
  MessageParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import debug from 'debug'
import { Message, Ollama, Tool } from 'ollama'
import { Observable, from, map } from 'rxjs'

import pkg from '../package.json'
import { TimeoutError, withTimeout } from './lib/promise-extras'
import { LargeLanguageProvider, connectServerToClient } from './llm'
import { e } from './logging'

const d = debug('b:llm')

// Reserve tokens for model responses
const MAX_ITERATIONS = 10 // Safety limit for iterations

// Timeout configuration (in milliseconds)
const TOOL_EXECUTION_TIMEOUT = 60 * 1000

// ---- Conversion Functions (moved to top) ----

function convertOllamaMessageToAnthropic(
  msg: Message
): Anthropic.Messages.MessageParam {
  if (msg.role === 'tool') {
    // Tool messages in Ollama -> tool_result content blocks in Anthropic
    let parsedContent
    try {
      parsedContent = JSON.parse(msg.content)
    } catch {
      // If parsing fails, use the raw string content
      parsedContent = msg.content
    }

    // Find the corresponding tool_call message to get the ID
    // NB: This relies on message order and might be fragile.
    // A better approach might involve tracking tool call IDs.
    // For now, we assume the preceding assistant message contains the call.
    // We don't have access to the message history here easily,
    // so we'll fabricate a plausible-looking ID. A real system might
    // need to pass the ID through.
    const toolUseId = `toolu_${Date.now()}` // Fabricated ID

    return {
      role: 'user', // Anthropic expects tool results in a user message
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId, // Need the ID from the tool_call message
          content: parsedContent,
        },
      ],
    }
  } else if (msg.role === 'assistant' && msg.tool_calls) {
    // Assistant message with tool calls
    const contentBlocks: ContentBlockParam[] = []
    if (msg.content) {
      contentBlocks.push({ type: 'text', text: msg.content })
    }

    msg.tool_calls.forEach((call) => {
      contentBlocks.push({
        type: 'tool_use',
        id: `toolu_${call.function.name}_${Date.now()}`, // Fabricate ID
        name: call.function.name,
        input: call.function.arguments,
      })
    })

    return {
      role: 'assistant',
      content: contentBlocks,
    }
  } else {
    // Standard user or assistant message without tools
    return {
      role: msg.role as 'user' | 'assistant',
      content: msg.content,
    }
  }
}

function convertAnthropicMessageToOllama(msg: MessageParam): Message {
  if (msg.role === 'user' && Array.isArray(msg.content)) {
    // Check if this user message contains tool results
    const toolResultBlock = msg.content.find(
      (block) => block.type === 'tool_result'
    )
    if (toolResultBlock && toolResultBlock.type === 'tool_result') {
      // This assumes only one tool result per user message, which matches
      // how we process Ollama tool responses currently.
      return {
        role: 'tool',
        content: JSON.stringify(toolResultBlock.content),
        // tool_call_id: toolResultBlock.tool_use_id, // Ollama Message doesn't have tool_call_id
      }
    }
  }

  // Handle standard messages or assistant messages with tool_use
  let contentString = ''
  if (typeof msg.content === 'string') {
    contentString = msg.content
  } else if (Array.isArray(msg.content)) {
    // Combine text blocks and represent tool_use blocks if needed (though Ollama expects calls from assistant)
    contentString = msg.content
      .map((block) => {
        if (block.type === 'text') {
          return block.text
        } else if (block.type === 'tool_use') {
          // Representing tool use in Ollama input is less direct.
          // We might stringify it or just include the intent.
          // For now, let's focus on the text parts for the user message.
          return `[Requesting tool: ${block.name}]`
        }
        return ''
      })
      .join('\n')
  }

  return {
    role: msg.role,
    content: contentString,
    // tool_calls are handled separately when generating the assistant response
  }
}

// ---- End Conversion Functions ----

export class OllamaLargeLanguageProvider implements LargeLanguageProvider {
  // Timeout configuration (in milliseconds)
  static OLLAMA_API_TIMEOUT = 5 * 60 * 1000

  private ollama: Ollama
  private model: string
  constructor(endpoint: string, model?: string) {
    this.model = model ?? 'qwen2.5:14b'
    this.ollama = new Ollama({ host: endpoint })
  }

  async getModelList(): Promise<string[]> {
    const response = await this.ollama.list()
    return response.models.map((model) => model.name)
  }

  executePromptWithTools(
    prompt: string,
    toolServers: McpServer[],
    previousMessages?: MessageParam[]
  ): Observable<MessageParam> {
    return from(
      this._executePromptWithTools(prompt, toolServers, previousMessages)
    ).pipe(map((m) => convertOllamaMessageToAnthropic(m)))
  }

  async *_executePromptWithTools(
    prompt: string,
    toolServers: McpServer[],
    previousMessages?: MessageParam[]
  ) {
    const modelName = this.model

    // Create a client for each tool server and connect them
    const clientServerPairs = toolServers.map((mcpServer, index) => {
      const client = new Client({
        name: `${pkg.name}-ollama-client-${index}`, // Unique client name
        version: pkg.version,
      })
      connectServerToClient(client, mcpServer.server)
      return { server: mcpServer, client, index }
    })

    // Aggregate tools from all clients and map tool names to clients
    let ollamaTools: Tool[] = []
    const toolClientMap = new Map<string, Client>()

    if (clientServerPairs.length > 0) {
      const toolLists = await Promise.all(
        clientServerPairs.map(async ({ client }) => {
          try {
            return await client.listTools()
          } catch (err) {
            e('Error listing tools for an Ollama client:', err)
            return { tools: [] } // Return empty list on error
          }
        })
      )

      clientServerPairs.forEach(({ client }, index) => {
        const tools = toolLists[index].tools
        tools.forEach((tool) => {
          const ollamaTool = {
            type: 'function' as const,
            function: {
              name: tool.name,
              description: tool.description || '',
              parameters: tool.inputSchema as any,
            },
          }
          ollamaTools.push(ollamaTool)
          toolClientMap.set(tool.name, client)
        })
      })
      d(
        'Aggregated %d Ollama tools from %d clients',
        ollamaTools.length,
        clientServerPairs.length
      )
    }

    // Track conversation and tool use to avoid infinite loops
    let iterationCount = 0

    // Convert previous Anthropic messages to Ollama format
    const msgs: Message[] = []

    if (previousMessages) {
      for (const msg of previousMessages) {
        msgs.push(convertAnthropicMessageToOllama(msg))
      }
    }

    // Add the current prompt as a user message if it's not empty
    if (prompt.trim()) {
      msgs.push({
        role: 'user',
        content: prompt,
      })
      yield msgs[msgs.length - 1]
    }

    // We're gonna keep looping until there are no more tool calls to satisfy
    while (iterationCount < MAX_ITERATIONS) {
      iterationCount++

      // Apply timeout to the Anthropic API call
      let response
      try {
        response = await withTimeout(
          this.ollama.chat({
            model: modelName,
            messages: msgs,
            tools: ollamaTools,
            stream: false,
            options: {
              temperature: 0.7,
              top_p: 0.9,
              top_k: 40,
              num_predict: 512,
            },
          }),
          OllamaLargeLanguageProvider.OLLAMA_API_TIMEOUT,
          `Ollama API call timed out after ${OllamaLargeLanguageProvider.OLLAMA_API_TIMEOUT}ms`
        )
      } catch (err) {
        if (err instanceof TimeoutError) {
          d('Ollama API call timed out: %s', err.message)
          // Add a system message about the timeout and continue to next iteration
          msgs.push({
            role: 'assistant',
            content: `I apologize, but the AI service took too long to respond. Let's continue with what we have so far.`,
          })

          yield msgs[msgs.length - 1]
          continue
        } else {
          // For other errors, log and rethrow
          e('Error in Ollama API call', err)
          throw err
        }
      }

      msgs.push(response.message)
      yield msgs[msgs.length - 1]

      if (
        !response.message.tool_calls ||
        response.message.tool_calls.length < 1
      ) {
        break
      }

      const toolCalls = response.message.tool_calls

      d('Processing %d tool calls', toolCalls.length)
      for (const toolCall of toolCalls) {
        const client = toolClientMap.get(toolCall.function.name)
        if (!client) {
          e(
            `Error: Could not find client for Ollama tool '${toolCall.function.name}'`
          )
          const errorMsg = `System error: Tool '${toolCall.function.name}' not found.`
          msgs.push({
            role: 'tool',
            content: errorMsg,
          })
          yield msgs[msgs.length - 1]
          continue // Skip this tool call
        }

        d('Calling Ollama tool: %s', toolCall.function.name)
        // Apply timeout to each tool call using the correct client
        try {
          const toolResp = await withTimeout(
            client.callTool({
              name: toolCall.function.name,
              arguments: toolCall.function.arguments as Record<string, any>,
            }),
            TOOL_EXECUTION_TIMEOUT,
            `Tool execution '${toolCall.function.name}' timed out after ${TOOL_EXECUTION_TIMEOUT}ms`
          )

          // Process successful response
          msgs.push({
            role: 'tool',
            content: JSON.stringify(toolResp.content),
          })
          yield msgs[msgs.length - 1]
        } catch (err) {
          // Handle errors (including timeout)
          let errorMsg = ''
          if (err instanceof TimeoutError) {
            e(`Tool execution timed out: ${toolCall.function.name}`)
            errorMsg = `Tool '${toolCall.function.name}' execution timed out after ${TOOL_EXECUTION_TIMEOUT}ms`
          } else {
            e(`Error executing tool ${toolCall.function.name}:`, err)
            errorMsg = `Error executing tool '${toolCall.function.name}': ${err instanceof Error ? err.message : String(err)}`
          }
          msgs.push({
            role: 'tool',
            content: errorMsg,
          })
          yield msgs[msgs.length - 1]
        }
      }
    }
  }
}
