import path from "path";
import fs from "fs-extra";
import axios from "axios";

import adminDb from "./database.ts";
import { REGION_LABELS } from "./dictionaries.ts";
import { generateImages, generateImageComposition, queryImageHistoryResult } from "@/api/controllers/images.ts";
import { generateVideo, queryVideoHistoryResult } from "@/api/controllers/videos.ts";
import logger from "@/lib/logger.ts";

const activeSubmitTaskIds = new Set<number>();
const activeCallbackTaskIds = new Set<number>();
const activeSubmitMemberIds = new Set<number>();

let submitTimer: NodeJS.Timeout | null = null;
let callbackTimer: NodeJS.Timeout | null = null;
let submitRunning = false;
let callbackRunning = false;
let memberCursor = 0;
let lastCallbackAt: string | null = null;

function regionPrefix(region: string) {
  if (region === REGION_LABELS.US) return "us-";
  if (region === REGION_LABELS.JP) return "jp-";
  if (region === REGION_LABELS.HK) return "hk-";
  if (region === REGION_LABELS.SG) return "sg-";
  return "";
}

function tokenForRegion(sessionId: string, region: string) {
  const prefix = regionPrefix(region);
  if (!prefix) return sessionId;

  const atIndex = sessionId.lastIndexOf("@");
  const head = atIndex > 0 ? sessionId.slice(0, atIndex + 1) : "";
  const token = atIndex > 0 ? sessionId.slice(atIndex + 1) : sessionId;
  if (/^(us|jp|hk|sg)-/i.test(token)) return sessionId;
  return `${head}${prefix}${token}`;
}

function isRemotePath(value: string) {
  return /^https?:\/\//i.test(value);
}

function isVideoTask(task: any) {
  const model = String(task.model || "").toLowerCase();
  return model.includes("video") || model.includes("seedance") || model.includes("sora") || model.includes("veo");
}

function isOmniReferenceModel(task: any) {
  const model = String(task.model || "").trim().toLowerCase();
  return model === "jimeng-video-seedance-2.0" || model === "jimeng-video-seedance-2.0-fast";
}

function materialType(item: any) {
  const type = String(item?.type || "").toLowerCase();
  if (type === "image" || type === "video") return type;

  const ext = path.extname(String(item?.path || "")).toLowerCase();
  if ([".mp4", ".mov", ".avi", ".mkv", ".webm"].includes(ext)) return "video";
  return "image";
}

function selectMember(config: any, excludedMemberIds = new Set<number>()) {
  const members = adminDb
    .listRunnableMemberAccounts(config.region, config.accountType)
    .filter((member: any) => !excludedMemberIds.has(Number(member.id)));
  if (!members.length) return null;
  const member = members[memberCursor % members.length];
  memberCursor += 1;
  return member;
}

function mergeMemberExclusions(...sets: Set<number>[]) {
  const merged = new Set<number>();
  sets.forEach((set) => set.forEach((id) => merged.add(Number(id))));
  return merged;
}

function hasSelectableMemberForTask(task: any, config: any, excludedMemberIds = new Set<number>()) {
  if (task.memberId) {
    const member = adminDb.findMemberById(Number(task.memberId));
    if (member?.sessionId && Number(member.status) === 1) return !excludedMemberIds.has(Number(member.id));
  }
  return adminDb
    .listRunnableMemberAccounts(config.region, config.accountType)
    .some((member: any) => !excludedMemberIds.has(Number(member.id)));
}

function busyMemberIds() {
  return mergeMemberExclusions(activeSubmitMemberIds);
}

function selectMemberForTask(task: any, config: any, excludedMemberIds = new Set<number>()) {
  if (task.memberId) {
    const member = adminDb.findMemberById(Number(task.memberId));
    if (member?.sessionId && Number(member.status) === 1) {
      if (excludedMemberIds.has(Number(member.id))) return null;
      return member;
    }
    logger.warn(`[TaskRunner] bound member is unavailable: task=${task.id}, memberId=${task.memberId}`);
  }
  return selectMember(config, excludedMemberIds);
}

function localFileObject(filePath: string, index: number) {
  return {
    filepath: filePath,
    path: filePath,
    originalFilename: path.basename(filePath) || `material_${index + 1}`,
  };
}

function taskLogLabel(task: any) {
  return `id=${task.id}, taskId=${task.taskId || "-"}, model=${task.model || "-"}, materials=${Array.isArray(task.materials) ? task.materials.length : 0}`;
}

function normalizeNotifyUrl(value: any) {
  const url = String(value || "").trim();
  return /^https?:\/\//i.test(url) ? url : "";
}

async function notifyTaskResult(task: any, payload: Record<string, any>) {
  const notifyUrl = normalizeNotifyUrl(task.notify);
  if (!notifyUrl) return;
  try {
    await axios.post(notifyUrl, payload, { timeout: 10000 });
    logger.info(`[TaskRunner] task result notified: task=${task.taskId || task.id}, url=${notifyUrl}`);
  } catch (error: any) {
    logger.error(`[TaskRunner] task result notify failed: task=${task.taskId || task.id}, url=${notifyUrl}, ${error?.message || error}`);
  }
}

async function submitTask(task: any, member: any) {
  const token = tokenForRegion(member.sessionId, member.region);
  const materials = Array.isArray(task.materials) ? task.materials : [];
  const materialPaths = materials.map((item: any) => item.path).filter(Boolean);
  let historyId: string;

  logger.info(`[TaskRunner] submitting task: ${taskLogLabel(task)}, member=${member.id || "-"}(${member.accountName || "-"})`);

  if (isVideoTask(task)) {
    const files: Record<string, any> = {};
    const remotePaths: string[] = [];
    const functionMode = isOmniReferenceModel(task) ? "omni_reference" : "first_last_frames";
    let httpRequest: any;

    if (functionMode === "omni_reference") {
      const body: Record<string, string> = {};
      let imageIndex = 1;
      let videoIndex = 1;

      materials.forEach((material: any, index: number) => {
        const materialPath = material?.path;
        if (!materialPath) return;

        const type = materialType(material);
        if (type === "video") {
          if (videoIndex > 3) {
            logger.warn(`Video task ${task.id} has more than 3 video material(s); extra omni video material ignored: ${materialPath}`);
            return;
          }
          const fieldName = `video_file_${videoIndex++}`;
          if (isRemotePath(materialPath)) body[fieldName] = materialPath;
          else files[fieldName] = localFileObject(materialPath, index);
        } else {
          if (imageIndex > 9) {
            logger.warn(`Video task ${task.id} has more than 9 image material(s); extra omni image material ignored: ${materialPath}`);
            return;
          }
          const fieldName = `image_file_${imageIndex++}`;
          if (isRemotePath(materialPath)) body[fieldName] = materialPath;
          else files[fieldName] = localFileObject(materialPath, index);
        }
      });

      httpRequest = { body };
    } else {
      const videoMaterialPaths = materials
        .filter((item: any) => !item.type || item.type === "image")
        .map((item: any) => item.path)
        .filter(Boolean)
        .slice(0, 2);
      if (materialPaths.length > videoMaterialPaths.length) {
        logger.warn(`Video task ${task.id} has ${materialPaths.length} material(s); first_last_frames uses the first 2 image material(s).`);
      }
      videoMaterialPaths.forEach((materialPath: string, index: number) => {
        if (isRemotePath(materialPath)) {
          remotePaths.push(materialPath);
        } else {
          files[`image_file_${index + 1}`] = localFileObject(materialPath, index);
        }
      });
    }

    logger.info(`[TaskRunner] -> generateVideo(${task.model}), functionMode=${functionMode}, localMaterials=${Object.keys(files).length}, remoteImages=${remotePaths.length}`);
    historyId = await generateVideo(task.model, task.prompt, {
      ratio: task.ratio || "1:1",
      resolution: task.resolution || "720p",
      duration: Number(task.duration || 5),
      filePaths: remotePaths,
      files,
      httpRequest,
      functionMode,
    }, token);
  } else if (materialPaths.length) {
    logger.info(`[TaskRunner] -> generateImageComposition(${task.model}), images=${materialPaths.length}`);
    const images = await Promise.all(materialPaths.map(async (materialPath: string) => {
      if (isRemotePath(materialPath)) return materialPath;
      return fs.readFile(materialPath);
    }));
    historyId = await generateImageComposition(task.model, task.prompt, images, {
      ratio: task.ratio || "1:1",
      resolution: task.resolution || "2k",
    }, token);
  } else {
    logger.info(`[TaskRunner] -> generateImages(${task.model}), text-to-image`);
    historyId = await generateImages(task.model, task.prompt, {
      ratio: task.ratio || "1:1",
      resolution: task.resolution || "2k",
    }, token);
  }

  adminDb.markTaskSubmitted(task.id, historyId, member);
  logger.info(`[TaskRunner] task submitted: ${taskLogLabel(task)}, historyId=${historyId}`);
}

function submitFailureReason(error: any) {
  const apiRet = error?.data?.ret ? `ret=${error.data.ret}, ` : "";
  const apiMessage = error?.data?.errmsg || error?.errmsg || error?.message || String(error);
  return `${apiRet}${apiMessage}`.slice(0, 500);
}

async function submitTaskWithMemberRotation(task: any, config: any, initialMember: any = null) {
  const attemptedMemberIds = new Set<number>();
  let lastReason = "";
  let nextMember = initialMember;

  while (true) {
    const member = nextMember || selectMemberForTask(task, config, mergeMemberExclusions(attemptedMemberIds, busyMemberIds()));
    nextMember = null;
    if (!member) {
      if (hasSelectableMemberForTask(task, config, attemptedMemberIds)) {
        logger.info(`[TaskRunner] task waiting for available member: ${taskLogLabel(task)}`);
        return;
      }
      const reason = lastReason
        ? `All runnable member accounts failed. Last error: ${lastReason}`
        : "No enabled member account matched current config";
      logger.warn(`[TaskRunner] no runnable member for task: ${taskLogLabel(task)}, region=${config.region}, accountType=${config.accountType}`);
      adminDb.markTaskSubmitFailed(task.id, reason);
      adminDb.markTaskGenerationFailed(task.id, reason);
      await notifyTaskResult(task, {
        task_id: task.taskId,
        status: "FAILURE",
        fail_reason: reason,
      });
      return;
    }

    const memberId = Number(member.id);
    attemptedMemberIds.add(memberId);
    activeSubmitMemberIds.add(memberId);

    try {
      await submitTask(task, member);
      return;
    } catch (error: any) {
      lastReason = submitFailureReason(error);
      logger.error(`[TaskRunner] submit failed, disabling member and retrying: task=${task.id}, member=${member.id}, ${lastReason}`);
      adminDb.closeMemberAccount(Number(member.id), lastReason);
    } finally {
      activeSubmitMemberIds.delete(memberId);
    }
  }
}

async function runSubmitBatch() {
  if (!submitRunning) {
    logger.info("[TaskRunner] submit batch skipped: processor is paused");
    return;
  }
  const config = adminDb.getSystemConfig();
  const maxParallel = Math.max(1, Number(config.maxParallelTasks || 1));
  const processingCount = adminDb.countProcessingGenerationTasks();
  if (processingCount > maxParallel) {
    logger.info(`[TaskRunner] submit batch skipped: processing generation tasks exceed maxParallel, processing=${processingCount}, maxParallel=${maxParallel}`);
    return;
  }
  const slots = Math.max(0, maxParallel - processingCount - activeSubmitTaskIds.size);
  if (!slots) {
    logger.info(`[TaskRunner] submit batch skipped: no available slot, processing=${processingCount}, active=${activeSubmitTaskIds.size}, maxParallel=${maxParallel}`);
    return;
  }

  const scanLimit = Math.max(slots, maxParallel * 4);
  const tasks = adminDb.listPendingTasks(scanLimit).filter((task: any) => !activeSubmitTaskIds.has(Number(task.id)));
  logger.info(`[TaskRunner] submit batch scan: pending=${tasks.length}, slots=${slots}, processing=${processingCount}, active=${activeSubmitTaskIds.size}, region=${config.region}, accountType=${config.accountType}`);
  if (!tasks.length) return;

  let started = 0;
  const reservedMemberIds = busyMemberIds();
  for (const task of tasks) {
    if (started >= slots) break;
    const member = selectMemberForTask(task, config, reservedMemberIds);
    if (!member) {
      if (hasSelectableMemberForTask(task, config)) {
        logger.info(`[TaskRunner] submit task skipped: all matching members are busy, ${taskLogLabel(task)}`);
        continue;
      }
    } else {
      reservedMemberIds.add(Number(member.id));
      activeSubmitMemberIds.add(Number(member.id));
    }

    activeSubmitTaskIds.add(task.id);
    started += 1;
    void submitTaskWithMemberRotation(task, config, member)
      .catch((error: any) => {
        logger.error(`Submit task failed: id=${task.id}, ${error.message}`);
        adminDb.markTaskSubmitFailed(task.id, error?.message || String(error));
      })
      .finally(() => activeSubmitTaskIds.delete(task.id));
  }
}

async function pollSubmittedTask(task: any) {
  const member = task.memberId ? adminDb.findMemberById(Number(task.memberId)) : null;
  if (!member?.sessionId) {
    const reason = "Task has no member account for callback polling";
    adminDb.markTaskGenerationFailed(task.id, reason);
    await notifyTaskResult(task, {
      task_id: task.taskId,
      status: "FAILURE",
      fail_reason: reason,
    });
    return;
  }

  const token = tokenForRegion(member.sessionId, member.region);
  const state = isVideoTask(task)
    ? await queryVideoHistoryResult(token, task.historyId)
    : await queryImageHistoryResult(token, task.historyId);

  if (state.isCompleted) {
    if (state.urls.length) {
      const downloadUrl = state.urls.join("\n");
      adminDb.markTaskGenerated(task.id, downloadUrl);
      await notifyTaskResult(task, {
        task_id: task.taskId,
        status: "SUCCESS",
        data: {
          output: downloadUrl,
          format: isVideoTask(task) ? "mp4" : "png",
        },
      });
    } else {
      const reason = "Generation completed but no result URL was found";
      adminDb.markTaskGenerationFailed(task.id, reason);
      await notifyTaskResult(task, {
        task_id: task.taskId,
        status: "FAILURE",
        fail_reason: reason,
      });
    }
  } else if (state.isFailed) {
    const reason = state.failCode || "Generation failed";
    adminDb.markTaskGenerationFailed(task.id, reason);
    await notifyTaskResult(task, {
      task_id: task.taskId,
      status: "FAILURE",
      fail_reason: reason,
    });
  }
}

export async function runCallbackOnce() {
  const tasks = adminDb.listSubmittedProcessingTasks().filter((task: any) => !activeCallbackTaskIds.has(Number(task.id)));
  await Promise.all(tasks.map(async (task: any) => {
    activeCallbackTaskIds.add(task.id);
    try {
      await pollSubmittedTask(task);
    } catch (error: any) {
      logger.error(`Callback poll failed: id=${task.id}, ${error.message}`);
    } finally {
      activeCallbackTaskIds.delete(task.id);
    }
  }));
  lastCallbackAt = new Date().toISOString();
}

export function startTaskProcessor() {
  submitRunning = true;
  if (!submitTimer) {
    submitTimer = setInterval(() => void runSubmitBatch(), 5000);
  }
  logger.info("[TaskRunner] task processor started");
  setImmediate(() => void runSubmitBatch());
  return getTaskRunnerStatus();
}

export function pauseTaskProcessor() {
  submitRunning = false;
  if (submitTimer) {
    clearInterval(submitTimer);
    submitTimer = null;
  }
  logger.info("[TaskRunner] task processor paused");
  return getTaskRunnerStatus();
}

export function startCallbackProcessor() {
  callbackRunning = true;
  if (callbackTimer) clearInterval(callbackTimer);
  const config = adminDb.getSystemConfig();
  const intervalMs = Math.max(1, Number(config.callbackIntervalMinutes || 1)) * 60 * 1000;
  callbackTimer = setInterval(() => void runCallbackOnce(), intervalMs);
  logger.info(`[TaskRunner] callback processor started, intervalMs=${intervalMs}`);
  setImmediate(() => void runCallbackOnce());
  return getTaskRunnerStatus();
}

export function pauseCallbackProcessor() {
  callbackRunning = false;
  if (callbackTimer) {
    clearInterval(callbackTimer);
    callbackTimer = null;
  }
  logger.info("[TaskRunner] callback processor paused");
  return getTaskRunnerStatus();
}

export function getTaskRunnerStatus() {
  return {
    submitRunning,
    callbackRunning,
    activeSubmitCount: activeSubmitTaskIds.size,
    activeCallbackCount: activeCallbackTaskIds.size,
    activeSubmitMemberCount: activeSubmitMemberIds.size,
    lastCallbackAt,
  };
}
