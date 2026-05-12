export const OPEN_STATUS = {
  DISABLED: 0,
  ENABLED: 1,
} as const;

export const TASK_SUBMIT_STATUS = {
  PENDING: 0,
  SUCCESS: 1,
  FAILED: 2,
} as const;

export const GENERATION_STATUS = {
  NONE: 0,
  PROCESSING: 1,
  GENERATED: 2,
  FAILED: 3,
} as const;

export const MEMBER_ACCOUNT_TYPE = {
  PAID: 1,
  FREE: 2,
} as const;

export const REGION_LABELS = {
  CN: "\u56fd\u533a",
  US: "\u7f8e\u533a",
  JP: "\u65e5\u533a",
  HK: "\u6e2f\u533a",
  SG: "\u65b0\u52a0\u5761\u533a",
} as const;

export type OpenStatusCode = (typeof OPEN_STATUS)[keyof typeof OPEN_STATUS];
export type TaskSubmitStatusCode = (typeof TASK_SUBMIT_STATUS)[keyof typeof TASK_SUBMIT_STATUS];
export type GenerationStatusCode = (typeof GENERATION_STATUS)[keyof typeof GENERATION_STATUS];
export type MemberAccountTypeCode = (typeof MEMBER_ACCOUNT_TYPE)[keyof typeof MEMBER_ACCOUNT_TYPE];

export function toOpenStatusCode(value: any): OpenStatusCode {
  if (Number(value) === OPEN_STATUS.DISABLED || value === false || value === "\u5173\u95ed") return OPEN_STATUS.DISABLED;
  return OPEN_STATUS.ENABLED;
}

export function toTaskSubmitStatusCode(value: any): TaskSubmitStatusCode {
  if (value === null || value === undefined || value === "" || Number(value) === TASK_SUBMIT_STATUS.PENDING || value === "待处理") return TASK_SUBMIT_STATUS.PENDING;
  if (Number(value) === TASK_SUBMIT_STATUS.FAILED || value === "\u5931\u8d25" || value === "失败") return TASK_SUBMIT_STATUS.FAILED;
  return TASK_SUBMIT_STATUS.SUCCESS;
}

export function toGenerationStatusCode(value: any): GenerationStatusCode {
  if (value === null || value === undefined || value === "" || Number(value) === GENERATION_STATUS.NONE) return GENERATION_STATUS.NONE;
  if (Number(value) === GENERATION_STATUS.PROCESSING || value === "\u751f\u6210\u4e2d") return GENERATION_STATUS.PROCESSING;
  if (Number(value) === GENERATION_STATUS.GENERATED || value === "\u5df2\u751f\u6210") return GENERATION_STATUS.GENERATED;
  return GENERATION_STATUS.FAILED;
}

export function toMemberAccountTypeCode(value: any): MemberAccountTypeCode {
  if (Number(value) === MEMBER_ACCOUNT_TYPE.PAID || value === "\u6536\u8d39") return MEMBER_ACCOUNT_TYPE.PAID;
  return MEMBER_ACCOUNT_TYPE.FREE;
}
