export { createEalClient, extractServerError } from './eal-client.ts';
export type { EalClient, EalClientOptions } from './eal-client.ts';
export type {
  CliPairClaimInput,
  CliPairPollResult,
  CliPairStartResult,
  CurrentUser,
  HouseholdMember,
} from './auth-types.ts';
export type {
  CloneTaskResult,
  CreateTaskInput,
  ListTasksInput,
  Task,
  TaskDetail,
  TaskEvent,
  UpdateTaskInput,
} from './task-types.ts';
export type {
  ChatAgentReply,
  ChatAgentRequest,
  ChatBrowserEvent,
  ChatSendFrame,
  Message,
} from './chat-types.ts';
export type {
  FamilyPhoneCallEvent,
  FamilyPhoneDevice,
  FamilyPhoneDeviceConnection,
  FamilyPhoneDeviceKind,
  FamilyPhonePairCompleteInput,
  FamilyPhonePairCompleteResult,
  FamilyPhonePairStartResult,
} from './family-phone-types.ts';
