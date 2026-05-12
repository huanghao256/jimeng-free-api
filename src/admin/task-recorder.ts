import adminDb, { TaskRecordInput } from "./database.ts";
import path from "path";
import { parseProxyFromToken, parseRegionFromToken } from "@/api/controllers/core.ts";
import { GENERATION_STATUS, REGION_LABELS, TASK_SUBMIT_STATUS } from "./dictionaries.ts";

export interface TaskMaterial {
  type?: string | null;
  name?: string | null;
  path: string;
  source?: string | null;
}

interface TaskContextInput {
  token: string;
  model: string;
  ratio?: string | null;
  resolution?: string | null;
  duration?: number | null;
  prompt: string;
  materials?: TaskMaterial[];
}

function regionName(token: string) {
  const region = parseRegionFromToken(token);
  if (region.isUS) return REGION_LABELS.US;
  if (region.isJP) return REGION_LABELS.JP;
  if (region.isHK) return REGION_LABELS.HK;
  if (region.isSG) return REGION_LABELS.SG;
  return REGION_LABELS.CN;
}

function maskToken(token: string) {
  if (!token) return "\u672a\u8bc6\u522b\u8d26\u53f7";
  if (token.length <= 12) return token;
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

function fileName(value: string, fallback: string) {
  const text = String(value || "").trim();
  if (!text) return fallback;
  return path.basename(text.replace(/\\/g, "/")) || fallback;
}

function materialTypeFromName(name: string) {
  const lower = name.toLowerCase();
  if (lower.includes("video")) return "video";
  if (lower.includes("image") || lower.includes("images")) return "image";
  return "file";
}

export function materialsFromPaths(paths: any[], type = "file", source = "path") {
  return (Array.isArray(paths) ? paths : [])
    .map((item, index) => {
      const materialPath = typeof item === "string" ? item : item?.url || item?.path;
      if (!materialPath) return null;
      return {
        type,
        name: fileName(materialPath, `素材${index + 1}`),
        path: String(materialPath),
        source,
      };
    })
    .filter(Boolean) as TaskMaterial[];
}

export function materialsFromFiles(files: any) {
  const entries: TaskMaterial[] = [];
  Object.entries(files || {}).forEach(([fieldName, value]) => {
    const list = Array.isArray(value) ? value : [value];
    list.forEach((file: any, index) => {
      const materialPath = file?.filepath || file?.path;
      if (!materialPath) return;
      entries.push({
        type: materialTypeFromName(fieldName),
        name: file?.originalFilename || fileName(materialPath, `${fieldName}_${index + 1}`),
        path: String(materialPath),
        source: "upload",
      });
    });
  });
  return entries;
}

export function materialsFromBodyFields(body: any, fieldNames: string[]) {
  return fieldNames
    .map((fieldName) => {
      const value = body?.[fieldName];
      if (typeof value !== "string" || !value.trim()) return null;
      return {
        type: materialTypeFromName(fieldName),
        name: fieldName,
        path: value.trim(),
        source: /^https?:\/\//i.test(value) ? "url" : "path",
      };
    })
    .filter(Boolean) as TaskMaterial[];
}

export function mergeMaterials(...groups: TaskMaterial[][]) {
  const seen = new Set<string>();
  const merged: TaskMaterial[] = [];
  groups.flat().forEach((item) => {
    const key = `${item.type || "file"}:${item.path}`;
    if (!item.path || seen.has(key)) return;
    seen.add(key);
    merged.push(item);
  });
  return merged;
}

export function buildTaskContext(input: TaskContextInput) {
  const { token } = parseProxyFromToken(input.token || "");
  const tokenWithoutRegion = /^(us|jp|hk|sg)-/i.test(token) ? token.slice(3) : "";
  const member = adminDb.findMemberBySessionId(token) || (tokenWithoutRegion ? adminDb.findMemberBySessionId(tokenWithoutRegion) : null);

  return {
    memberId: member?.id || null,
    accountName: member?.accountName || maskToken(token),
    model: input.model,
    region: member?.region || regionName(token),
    ratio: input.ratio || null,
    resolution: input.resolution || null,
    duration: input.duration ?? null,
    prompt: input.prompt,
    materials: input.materials || [],
    createdAt: new Date().toISOString(),
  };
}

export function createSubmittedTask(base: ReturnType<typeof buildTaskContext>, historyId: string) {
  return adminDb.createTask({
    ...base,
    historyId,
    submitStatus: TASK_SUBMIT_STATUS.SUCCESS,
    generationStatus: GENERATION_STATUS.PROCESSING,
  });
}

export function createFailedSubmitTask(base: ReturnType<typeof buildTaskContext>, reason: string) {
  return adminDb.createTask({
    ...base,
    historyId: null,
    submitStatus: TASK_SUBMIT_STATUS.FAILED,
    submitFailReason: reason,
    generationStatus: null,
  } as TaskRecordInput);
}

export function markTaskGenerated(taskId: number | null, urls: string[]) {
  if (!taskId) return;
  adminDb.markTaskGenerated(taskId, urls.filter(Boolean).join("\n"));
}

export function markTaskGenerationFailed(taskId: number | null, reason: string) {
  if (!taskId) return;
  adminDb.markTaskGenerationFailed(taskId, reason);
}

export function errorMessage(error: any) {
  return error?.message ? String(error.message) : String(error);
}
