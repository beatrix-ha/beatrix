import { MessageParam } from '@anthropic-ai/sdk/resources/index.js'
import { messagesToString } from '../shared/prompt'
import {
  ANTHROPIC_EVAL_MODEL,
  AnthropicLargeLanguageProvider,
} from './anthropic'
import { firstValueFrom, lastValueFrom, toArray } from 'rxjs'
import { LargeLanguageProvider } from './llm'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { asyncMap } from '@anaisbetts/commands'
import { createNotifyServer } from './mcp/notify'
import debug from 'debug'

import mockServices from '../mocks/services.json'
import mockStates from '../mocks/states.json'
import { HassServices } from 'home-assistant-js-websocket'
import { fetchHAUserInformation } from './lib/ha-ws-api'
import { createHomeAssistantServer } from './mcp/home-assistant'

const d = debug('ha:eval')

export type ScenarioResult = {
  prompt: string
  toolsDescription: string
  messages: MessageParam[]
  gradeResults: GradeResult[]
  finalScore: number
  finalScorePossible: number
}

export type GradeResult = {
  score: number
  possible_score: number
  grader_info: string
}

export type Grader = (messages: MessageParam[]) => Promise<GradeResult>

type LlmEvalResponse = {
  grade: number
  reasoning: string
  suggestions: string
}

export async function runScenario(
  llm: LargeLanguageProvider,
  prompt: string,
  tools: McpServer[],
  toolsDescription: string,
  graders: Grader[]
): Promise<ScenarioResult> {
  d(
    'Starting scenario with %d tools and %d graders',
    tools.length,
    graders.length
  )
  d('Prompt: %s', prompt.substring(0, 100) + (prompt.length > 100 ? '...' : ''))

  const messages = await firstValueFrom(
    llm.executePromptWithTools(prompt, tools).pipe(toArray())
  )
  d('Received %d messages from LLM', messages.length)

  d('Applying %d graders to messages', graders.length)
  const gradeResults = Array.from(
    (await asyncMap(graders, async (g) => g(messages), 2)).values()
  )

  const { finalScore, finalScorePossible } = gradeResults.reduce(
    (acc, x) => {
      acc.finalScore += x.score
      acc.finalScorePossible += x.possible_score
      return acc
    },
    { finalScore: 0, finalScorePossible: 0 }
  )
  d(
    'Final score: %d/%d (%.1f%%)',
    finalScore,
    finalScorePossible,
    finalScorePossible > 0 ? (finalScore / finalScorePossible) * 100 : 0
  )

  return {
    prompt,
    toolsDescription,
    messages,
    gradeResults,
    finalScore,
    finalScorePossible,
  }
}

/*
 * Tools
 */

export function createDefaultMockedTools(llm: LargeLanguageProvider) {
  d('Creating default mocked tools')
  return [
    createNotifyServer(null, {
      mockFetchServices: async () => mockServices as unknown as HassServices,
      mockFetchUsers: async () => fetchHAUserInformation(null, { mockStates }),
      mockSendNotification: async () => {},
    }),
    createHomeAssistantServer(null, llm, {
      testMode: true,
      mockFetchStates: async () => mockStates,
    }),
  ]
}

/*
 * Graders
 */

export function gradeViaSearchForContent(...content: string[]): Grader {
  d(
    'Creating search content grader with %d terms to search for',
    content.length
  )
  return async (messages: MessageParam[]) => {
    const lastMsg = messagesToString([messages[messages.length - 1]])
    d('Grading last message with length %d', lastMsg.length)

    const score = content.reduce((acc, needle) => {
      const found = lastMsg.includes(needle)
      d(
        'Searching for "%s": %s',
        needle.substring(0, 20) + (needle.length > 20 ? '...' : ''),
        found ? 'FOUND' : 'NOT FOUND'
      )
      return found ? acc + 1 : acc
    }, 0)

    const info = content.map((x) => `"${x}"`).join(', ')
    d('Search grader score: %d/%d', score, content.length)
    return {
      score: score,
      possible_score: content.length,
      grader_info: `Looking for ${info}`,
    }
  }
}

export function gradeContentViaPrompt(goal: string): Grader {
  d(
    'Creating LLM-based content evaluation grader with goal: %s',
    goal.substring(0, 50) + (goal.length > 50 ? '...' : '')
  )

  const llm = new AnthropicLargeLanguageProvider(
    process.env.ANTHROPIC_API_KEY!,
    ANTHROPIC_EVAL_MODEL
  )

  return async (messages: MessageParam[]) => {
    d('Grading %d messages with LLM', messages.length)
    const allMsgs = messagesToString(messages, true)
    d('Combined message length: %d characters', allMsgs.length)

    d('Sending evaluation prompt to LLM')
    const evalMsg = await lastValueFrom(
      llm.executePromptWithTools(evalPrompt(goal, allMsgs), [])
    )

    try {
      const response = messagesToString([evalMsg]).trim()
      d('Received LLM evaluation response: %s', response)

      const { grade, reasoning, suggestions } = JSON.parse(
        response
      ) as LlmEvalResponse
      d('LLM evaluation grade: %d/5', grade)

      return {
        score: grade,
        possible_score: 5,
        grader_info: `Reasoning: ${reasoning}, Suggestions: ${suggestions}`,
      }
    } catch (err) {
      d('Error parsing LLM evaluation response: %o', err)
      throw err
    }
  }
}

const evalPrompt = (
  goal: string,
  content: string
) => `You are an objective evaluation grader. Based on how well the result meets the specified goal, assign a grade from 1-5.

<DESIRED_GOAL>
${goal}
</DESIRED_GOAL>

<EVAL_RESULT>
${content}
</EVAL_RESULT>

Consider completeness, accuracy, relevance, clarity, and effectiveness in your assessment.

Provide your assessment as a JSON object with the following example structure:

{
  "grade": 3,
  "reasoning": "The result meets basic expectations by addressing the core elements of the goal. It provides accurate information on the main points, though it lacks detail in some areas. The response is relevant to the query and clearly written, though the organization could be improved. It would be sufficiently useful for the intended purpose, though not optimal.",
  "suggestions": "To improve, the response should address all aspects mentioned in the goal, particularly [specific missing elements]. Additional detail on [specific topics] would strengthen the result. Consider reorganizing the information to improve flow and emphasize key points."
}

The JSON object should validate against the following TypeScript schema:

type EvalResult = {
	grade: number
	reasoning: string
	suggestions: string
}

Remember that the grade should be a number from 1-5, where:
1 = Poor (Far below expectations)
2 = Fair (Below expectations)
3 = Satisfactory (Meets basic expectations)
4 = Good (Exceeds expectations)
5 = Excellent (Far exceeds expectations)

Return **only** the JSON object, without any additional text or explanation. Do *not* include Markdown formatters.
`
