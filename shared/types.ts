import { MessageParam } from '@anthropic-ai/sdk/resources/index.mjs'

export type ModelDriverType = 'anthropic' | 'ollama' | 'openai'

export type SignalType = 'cron' | 'state' | 'event' | 'offset' | 'time'

export type AutomationType = 'manual' | 'determine-signal' | 'execute-signal'

export interface Automation {
  hash: string
  contents: string
  fileName: string
}

export type StateRegexSignal = {
  type: 'state'
  entityIds: string[]
  regex: string
}

export type CronSignal = {
  type: 'cron'
  cron: string
}

export type RelativeTimeSignal = {
  type: 'offset'
  offsetInSeconds: number
}

export type AbsoluteTimeSignal = {
  type: 'time'
  iso8601Time: string // ISO 8601 date and time format
}

export type SignalData =
  | CronSignal
  | StateRegexSignal
  | RelativeTimeSignal
  | AbsoluteTimeSignal

export interface SignalEntry {
  createdAt: Date
  type: SignalType
  data: string
}

export interface SignalHandlerInfo {
  readonly automation: Automation
  readonly friendlySignalDescription: string
  readonly isValid: boolean
}

export interface CallServiceLogEntry {
  createdAt: Date
  service: string
  data: string
  target: string
}

export interface AutomationLogEntry {
  createdAt: Date
  automation: Automation | null
  type: AutomationType
  messages: MessageParam[]

  servicesCalled: CallServiceLogEntry[]

  signaledBy: SignalData | null
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
