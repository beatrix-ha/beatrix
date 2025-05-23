import fs from 'node:fs/promises'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { lastValueFrom, toArray } from 'rxjs'

import { Automation } from '../../shared/types'
import { formatDateForLLM } from '../lib/date-utils'
import { i } from '../logging'
import { createHomeAssistantServer } from '../mcp/home-assistant'
import { createSchedulerServer } from '../mcp/scheduler'
import { agenticReminders } from '../prompts'
import { AutomationRuntime, getMemoryFile, now } from './automation-runtime'
import { modelSpecFromAutomation } from './parser'

export async function rescheduleAutomations(
  runtime: AutomationRuntime,
  automations: Automation[]
) {
  for (const automation of automations) {
    i(`Examining automation: ${automation.fileName} (${automation.hash})`)
    const automationRecord = await runtime.db
      .selectFrom('signals')
      .where('automationHash', '=', automation.hash)
      .where('isDead', '!=', true)
      .select('id')
      .executeTakeFirst()

    if (automationRecord) {
      i(
        `Automation ${automation.fileName} (${automation.hash}) already has signals, skipping rescheduling.`
      )
      continue
    }

    i(
      `Querying LLM to determine scheduling for automation: ${automation.fileName}`
    )
    await runSchedulerForAutomation(runtime, automation)
  }
}

export async function runSchedulerForAutomation(
  runtime: AutomationRuntime,
  automation: Automation
) {
  const tools = createDefaultSchedulerTools(runtime, automation)

  const memory = await fs.readFile(getMemoryFile(runtime), 'utf-8')
  const llm = runtime.llmFactory(modelSpecFromAutomation(automation))

  i('Scheduling via model: ', llm.getModelWithDriver())
  const msgs = await lastValueFrom(
    llm
      .executePromptWithTools(
        schedulerPrompt(runtime, automation.contents, memory),
        tools
      )
      .pipe(toArray())
  )

  await runtime.db
    .insertInto('automationLogs')
    .values({
      createdAt: now(runtime).toISO()!,
      type: 'determine-signal',
      automationHash: automation.hash,
      messageLog: JSON.stringify(msgs),
    })
    .execute()
}

export function createDefaultSchedulerTools(
  runtime: AutomationRuntime,
  automation: Automation
): McpServer[] {
  return [
    createHomeAssistantServer(runtime, { schedulerMode: true }),
    createSchedulerServer(
      runtime.db,
      automation.hash,
      runtime.timezone || 'Etc/UTC',
      runtime.api // Pass the Home Assistant API for state validation
    ),
  ]
}

export const schedulerPrompt = (
  runtime: AutomationRuntime,
  automation: string,
  memory: string
) => {
  return `
<task>
You are an automation scheduling assistant for Home Assistant. Your job is to analyze the current automation instructions and determine the appropriate scheduling actions needed.

Your primary responsibility is to ensure that automations run at the correct times or in response to the right triggers based on the instructions.
</task>

${agenticReminders}

<automation_instructions>
${automation}
</automation_instructions>

<current_date_time>${formatDateForLLM(now(runtime))}</current_date_time>

<saved_memory>
${memory}
</saved_memory>

<instructions>
Please follow these steps:

1. First, use the list-scheduled-triggers tool to see what schedules are currently active for this automation.
2. Carefully analyze the automation instructions to understand:
   - When the automation should run (time-based triggers)
   - What conditions should trigger the automation (state-based triggers)
   - Any patterns or recurring schedules mentioned
   - Any one-time events that require absolute time scheduling

3. Based on your analysis, determine if:
   - The current triggers are appropriate and sufficient
   - Any triggers need to be removed (using cancel-all-scheduled-triggers)
   - New triggers need to be added

4. If new triggers are needed, select the most appropriate trigger type:
   - For recurring time patterns, use create-cron-trigger
   - For state changes matching text patterns, use create-state-regex-trigger
   - For numeric states within a range for a duration, use create-state-range-trigger
   - For delays or offsets, use create-relative-time-trigger
   - For specific future times, use create-absolute-time-trigger

5. Provide a brief explanation of your decision process and actions taken
</instructions>

Based on the current date and time, and the automation instructions provided above, please analyze the current scheduling configuration and make any necessary adjustments.

First, use the list-scheduled-triggers tool to see what's currently configured, then determine what changes (if any) are needed.

<automation_instructions>
${automation}
</automation_instructions>
`
}
