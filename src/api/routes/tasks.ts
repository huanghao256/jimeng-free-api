import path from "path";
import _ from "lodash";

import Request from "@/lib/request/Request.ts";
import adminDb from "@/admin/database.ts";
import { GENERATION_STATUS, TASK_SUBMIT_STATUS } from "@/admin/dictionaries.ts";

function isAbsoluteDiskPath(value: any) {
  return _.isString(value) && path.isAbsolute(value);
}

function materialTypeFromPath(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if ([".mp4", ".mov", ".avi", ".mkv", ".webm"].includes(ext)) return "video";
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"].includes(ext)) return "image";
  return "file";
}

function materialsFromLocalPaths(filePaths: string[]) {
  return filePaths.map((filePath, index) => ({
    type: materialTypeFromPath(filePath),
    name: path.basename(filePath) || `素材${index + 1}`,
    path: filePath,
    source: "path",
  }));
}

function pickMember(region: string, accountType: number) {
  const members = adminDb.listMemberAccounts();
  return members.find((member: any) =>
    Number(member.status) === 1 &&
    member.region === region &&
    Number(member.accountType) === Number(accountType)
  ) || members.find((member: any) =>
    Number(member.status) === 1 &&
    member.region === region
  ) || members.find((member: any) => Number(member.status) === 1) || null;
}

export default {
  prefix: "/v1/tasks",

  post: {
    "/create": async (request: Request) => {
      request
        .validate("body.model", _.isString)
        .validate("body.prompt", _.isString)
        .validate("body.ratio", v => _.isUndefined(v) || _.isString(v))
        .validate("body.resolution", v => _.isUndefined(v) || _.isString(v))
        .validate("body.duration", v => _.isUndefined(v) || (_.isFinite(v) && Number.isInteger(v)))
        .validate("body.notify", v => _.isUndefined(v) || _.isString(v))
        .validate("body.filePaths", v => _.isNil(v) || (_.isArray(v) && v.length <= 12 && v.every(isAbsoluteDiskPath)));

      const config = adminDb.getSystemConfig();
      const {
        model,
        prompt,
        ratio = "1:1",
        resolution = "720p",
        duration = null,
        filePaths = [],
        memberId,
        accountName,
        region = config.region,
        notify = null,
        taskId = `api_task_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      } = request.body;
      const selectedMember = memberId
        ? adminDb.listMemberAccounts().find((member: any) => Number(member.id) === Number(memberId))
        : pickMember(region, config.accountType);

      const id = adminDb.createTask({
        taskId,
        memberId: selectedMember?.id || null,
        accountName: accountName || selectedMember?.accountName || "API创建任务",
        model,
        region,
        ratio,
        resolution,
        duration,
        prompt,
        materials: materialsFromLocalPaths(filePaths),
        submitStatus: TASK_SUBMIT_STATUS.PENDING,
        generationStatus: GENERATION_STATUS.NONE,
        notify,
      });
      const task = adminDb.listTasks().find((row: any) => Number(row.id) === Number(id));

      return {
        id,
        taskId,
        task,
      };
    },
  },
};
