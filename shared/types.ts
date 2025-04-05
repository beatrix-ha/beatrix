import { MessageParam } from '@anthropic-ai/sdk/resources/index.mjs'

export type ModelDriverType = 'anthropic' | 'ollama' | 'openai'

export type SignalType = 'cron' | 'state' | 'event'

export type AutomationType = 'manual' | 'determine-signal' | 'execute-signal'

export interface Automation {
  hash: string
  contents: string
  fileName: string
}

export type StateRegexTrigger = {
  type: 'state'
  entityIds: string[]
  regex: string
}

export type CronTrigger = {
  type: 'cron'
  cron: string
}

export type RelativeTimeTrigger = {
  type: 'offset'
  offsetInSeconds: number
  repeatForever: boolean
}

export type AbsoluteTimeTrigger = {
  type: 'time'
  iso8601Time: string // ISO 8601 date and time format
}

export interface SignalEntry {
  createdAt: Date
  type: SignalType
  data: string
}

export interface CallServiceLogEntry {
  createdAt: Date
  service: string
  data: string
  target: string
}

export interface AutomationLogEntry {
  type: AutomationType
  createdAt: Date
  messages: MessageParam[]

  servicesCalled: CallServiceLogEntry[]

  automation: Automation | null

  signaledBy:
    | CronTrigger
    | StateRegexTrigger
    | RelativeTimeTrigger
    | AbsoluteTimeTrigger
    | null
}

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
  possibleScore: number
  graderInfo: string
}
