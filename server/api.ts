import { MessageParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { DateTime } from 'luxon'
import path from 'node:path'
import {
  Observable,
  concatMap,
  from,
  generate,
  mergeMap,
  of,
  share,
  toArray,
} from 'rxjs'

import { MessageParamWithExtras, ServerWebsocketApi } from '../shared/api'
import {
  Automation,
  AutomationLogEntry,
  ScenarioResult,
  SignalHandlerInfo,
  TypeHint,
} from '../shared/types'
import { AppConfig } from '../shared/types'
import { pick } from '../shared/utility'
import { fetchAutomationLogs } from './db'
import { createBuiltinServers, createDefaultLLMProvider } from './llm'
import { getSystemPrompt } from './prompts'
import { runAllEvals, runQuickEvals } from './run-evals'
import {
  AutomationRuntime,
  LiveAutomationRuntime,
  now,
} from './workflow/automation-runtime'
import { automationFromString } from './workflow/parser'

export class ServerWebsocketApiImpl implements ServerWebsocketApi {
  public constructor(
    private config: AppConfig,
    private runtime: AutomationRuntime,
    private notebookDirectory: string,
    private testMode: boolean,
    private evalMode: boolean
  ) {}

  getDriverList(): Observable<string[]> {
    const list = []
    if (this.config.anthropicApiKey) {
      list.push('anthropic')
    }
    if (this.config.ollamaHost) {
      list.push('ollama')
    }

    if (this.config.openAIProviders && this.config.openAIProviders.length > 0) {
      list.push(
        ...this.config.openAIProviders.map((x) => x.providerName ?? 'openai')
      )
    }

    return of(list)
  }

  getModelListForDriver(driver: string): Observable<string[]> {
    const llm = createDefaultLLMProvider(this.config, driver.toLowerCase())
    return from(llm.getModelList())
  }

  getAutomationLogs(beforeTimestamp?: Date): Observable<AutomationLogEntry[]> {
    return from(
      fetchAutomationLogs(
        this.runtime.db,
        this.runtime.automationList,
        DateTime.fromJSDate(beforeTimestamp ?? new Date()).setZone(
          this.runtime.timezone
        )
      )
    )
  }

  getAutomations(): Observable<Automation[]> {
    return of(
      this.filterAutomationPaths(
        this.runtime.notebookDirectory ?? '',
        this.runtime.automationList
      )
    )
  }

  getCues(): Observable<Automation[]> {
    return of(
      this.filterAutomationPaths(
        this.runtime.notebookDirectory ?? '',
        this.runtime.cueList
      )
    )
  }

  private filterAutomationPaths(
    notebookDirectory: string,
    automations: Automation[]
  ) {
    return automations.map((x) =>
      automationFromString(
        x.contents,
        x.fileName.replace(notebookDirectory + path.sep, ''),
        true
      )
    )
  }

  getScheduledSignals(): Observable<SignalHandlerInfo[]> {
    return of(
      // NB: If we don't do this, we will end up trying to serialize an Observable
      // which obvs won't work
      this.runtime.scheduledSignals.map((x) => {
        const ret = pick(x, [
          'automation',
          'friendlySignalDescription',
          'isValid',
          'signal',
        ])

        // Make the filenames relative to the automation dir when returning them
        ret.automation.fileName = ret.automation.fileName.replace(
          `${this.runtime.notebookDirectory}${path.sep}`,
          ''
        )

        return ret
      })
    )
  }

  getConfig(): Observable<AppConfig> {
    return of(this.config)
  }

  setConfig(config: AppConfig): Observable<void> {
    return from(this.runtime.saveConfigAndClose(config))
  }

  handlePromptRequest(
    prompt: string,
    model?: string,
    driver?: string,
    previousConversationId?: number,
    typeHint?: TypeHint
  ): Observable<MessageParamWithExtras> {
    const rqRuntime = new LiveAutomationRuntime(
      this.runtime.api,
      () => createDefaultLLMProvider(this.config, driver, model),
      this.runtime.db,
      this.notebookDirectory
    )

    const tools = createBuiltinServers(rqRuntime, null, {
      testMode: this.testMode || this.evalMode,
      includeCueServer: typeHint === 'chat',
    })

    const convo = previousConversationId
      ? from(
          this.runtime.db
            .selectFrom('automationLogs')
            .select('messageLog')
            .where('id', '=', previousConversationId)
            .executeTakeFirst()
            .then((x) => JSON.parse(x?.messageLog ?? '[]') as MessageParam[])
        )
      : of([])

    let serverId: bigint | undefined = previousConversationId
      ? BigInt(previousConversationId)
      : undefined
    let previousMessages: MessageParam[] = []

    const resp = convo.pipe(
      mergeMap((prevMsgs) => {
        const msgs: MessageParam[] = prevMsgs.map((msg) =>
          pick(msg, ['content', 'role'])
        )

        previousMessages = msgs
        const llm = this.runtime.llmFactory()
        if (prevMsgs.length > 0) {
          // If we are in a continuing conversation, we don't include the system
          // prompt
          return llm.executePromptWithTools(prompt, tools, msgs)
        } else {
          return from(getSystemPrompt(this.runtime, typeHint ?? 'debug')).pipe(
            mergeMap((sysPrompt) => {
              const finalPromptText = `${sysPrompt}\n${prompt}`
              return llm.executePromptWithTools(finalPromptText, tools, msgs)
            })
          )
        }
      }),
      mergeMap((msg) => {
        // NB: We insert into the database twice so that the caller can get
        // the ID faster even though it's a little hamfisted
        if (!serverId) {
          const insert = this.runtime.db
            .insertInto('automationLogs')
            .values({
              createdAt: now(this.runtime).toISO()!,
              type: 'manual',
              messageLog: JSON.stringify([msg]),
            })
            .execute()
            .then((x) => {
              serverId = x[0].insertId
              return x
            })

          return from(
            insert.then((x) =>
              Object.assign({}, msg, { serverId: Number(x[0].insertId) })
            )
          )
        } else {
          return of(Object.assign({}, msg, { serverId: Number(serverId) }))
        }
      }),
      share()
    )

    resp
      .pipe(
        toArray(),
        mergeMap(async (newMsgs) => {
          const filteredNewMsgs: MessageParam[] = newMsgs.map((msg: any) =>
            pick(msg, ['content', 'role'])
          )

          const fullMessageLog = [...previousMessages, ...filteredNewMsgs]

          await this.runtime.db
            .updateTable('automationLogs')
            .set({
              type: 'manual',
              messageLog: JSON.stringify(fullMessageLog),
            })
            .where('id', '=', Number(serverId!))
            .execute()
        })
      )
      .subscribe()

    return resp
  }

  runEvals(
    model: string,
    driver: string,
    type: 'all' | 'quick',
    count: number
  ): Observable<ScenarioResult> {
    const counter = generate({
      initialState: 0,
      iterate: (x) => x + 1,
      condition: (x) => x < count,
    })

    const runEvals = type === 'all' ? runAllEvals : runQuickEvals
    return from(
      counter.pipe(
        concatMap(() =>
          runEvals(() => createDefaultLLMProvider(this.config, driver, model))
        )
      )
    )
  }
}
