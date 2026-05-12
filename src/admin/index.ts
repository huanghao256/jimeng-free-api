import path from "path";
import fs from "fs-extra";
import KoaRouter from "koa-router";

import adminDb from "./database.ts";
import {
  getTaskRunnerStatus,
  pauseCallbackProcessor,
  pauseTaskProcessor,
  startCallbackProcessor,
  startTaskProcessor,
} from "./task-runner.ts";

const viewsDir = path.join(path.resolve(), "views");
const assetTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".html": "text/html; charset=utf-8",
};

function normalizeId(value: any) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new Error("无效的ID");
  return id;
}

function normalizeIds(value: any) {
  if (!Array.isArray(value)) throw new Error("ids必须是数组");
  return value.map((id) => normalizeId(id));
}

function parseSocks5Lines(text: string) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const parts = line.split(":");
      if (parts.length !== 4) throw new Error(`第${index + 1}行格式错误，应为 hostname:port:username:password`);
      const [host, portText, account, password] = parts.map((part) => part.trim());
      const port = Number(portText);
      if (!host || !account || !password || !Number.isInteger(port) || port <= 0) {
        throw new Error(`第${index + 1}行内容无效，请检查主机、端口、账号和密码`);
      }
      return { host, port, account, password, status: 1 };
    });
}

function readView(fileName: string) {
  return fs.readFileSync(path.join(viewsDir, fileName), "utf8");
}

function sendView(ctx: any, fileName: string) {
  ctx.type = "text/html; charset=utf-8";
  ctx.body = readView(fileName);
}

function sendJson(ctx: any, data: any, message = "OK") {
  ctx.type = "application/json; charset=utf-8";
  ctx.body = {
    code: 0,
    message,
    data,
  };
}

function getBody(ctx: any) {
  return ctx.request.body || {};
}

export default function mountAdmin(app: any) {
  adminDb.init();

  const router = new KoaRouter();

  router.get("/admin", async (ctx) => {
    ctx.redirect("/admin/socks5");
  });

  router.get("/admin/socks5", async (ctx) => sendView(ctx, "admin-socks5.html"));
  router.get("/admin/tasks", async (ctx) => sendView(ctx, "admin-tasks.html"));
  router.get("/admin/members", async (ctx) => sendView(ctx, "admin-members.html"));
  router.get("/admin/system", async (ctx) => sendView(ctx, "admin-system.html"));

  router.get("/admin/assets/:file", async (ctx) => {
    const fileName = path.basename(ctx.params.file);
    const ext = path.extname(fileName);
    if (!assetTypes[ext]) {
      ctx.status = 404;
      return;
    }

    const filePath = path.join(viewsDir, fileName);
    if (!filePath.startsWith(viewsDir) || !(await fs.pathExists(filePath))) {
      ctx.status = 404;
      return;
    }

    ctx.type = assetTypes[ext];
    ctx.body = await fs.readFile(filePath, "utf8");
  });

  router.get("/admin/api/socks5", async (ctx) => {
    sendJson(ctx, adminDb.listSocks5Accounts());
  });

  router.post("/admin/api/socks5", async (ctx) => {
    const id = adminDb.createSocks5Account(getBody(ctx));
    sendJson(ctx, { id }, "已创建");
  });

  router.post("/admin/api/socks5/batch", async (ctx) => {
    const body = getBody(ctx);
    const items = Array.isArray(body.items) ? body.items : parseSocks5Lines(body.text);
    const ids = adminDb.createSocks5Accounts(items);
    sendJson(ctx, { count: ids.length, ids }, `已添加${ids.length}个Socket5账号`);
  });

  router.put("/admin/api/socks5/:id", async (ctx) => {
    adminDb.updateSocks5Account(normalizeId(ctx.params.id), getBody(ctx));
    sendJson(ctx, true, "已保存");
  });

  router.delete("/admin/api/socks5/:id", async (ctx) => {
    adminDb.deleteSocks5Account(normalizeId(ctx.params.id));
    sendJson(ctx, true, "已删除");
  });

  router.post("/admin/api/socks5/batch-delete", async (ctx) => {
    const count = adminDb.deleteSocks5Accounts(normalizeIds(getBody(ctx).ids));
    sendJson(ctx, { count }, `已删除${count}个Socket5账号`);
  });

  router.post("/admin/api/socks5/batch-status", async (ctx) => {
    const body = getBody(ctx);
    const count = adminDb.updateSocks5AccountsStatus(normalizeIds(body.ids), Number(body.status) as any);
    sendJson(ctx, { count }, `已更新${count}个Socket5账号`);
  });

  router.get("/admin/api/members", async (ctx) => {
    sendJson(ctx, adminDb.listMemberAccounts());
  });

  router.post("/admin/api/members", async (ctx) => {
    const id = adminDb.createMemberAccount(getBody(ctx));
    sendJson(ctx, { id }, "已创建");
  });

  router.post("/admin/api/members/import", async (ctx) => {
    const rows = getBody(ctx).rows;
    if (!Array.isArray(rows)) throw new Error("导入数据必须是数组");
    const ids = adminDb.importMemberAccounts(rows);
    sendJson(ctx, { count: ids.length, ids }, `已导入${ids.length}个会员账号`);
  });

  router.post("/admin/api/members/batch-delete", async (ctx) => {
    const count = adminDb.deleteMemberAccounts(normalizeIds(getBody(ctx).ids));
    sendJson(ctx, { count }, `已删除${count}个会员账号`);
  });

  router.post("/admin/api/members/batch-status", async (ctx) => {
    const body = getBody(ctx);
    const count = adminDb.updateMemberAccountsStatus(normalizeIds(body.ids), Number(body.status) as any);
    sendJson(ctx, { count }, `已更新${count}个会员账号`);
  });

  router.put("/admin/api/members/:id", async (ctx) => {
    adminDb.updateMemberAccount(normalizeId(ctx.params.id), getBody(ctx));
    sendJson(ctx, true, "已保存");
  });

  router.delete("/admin/api/members/:id", async (ctx) => {
    adminDb.deleteMemberAccount(normalizeId(ctx.params.id));
    sendJson(ctx, true, "已删除");
  });

  router.get("/admin/api/tasks", async (ctx) => {
    sendJson(ctx, adminDb.listTasks());
  });

  router.get("/admin/api/task-runtime", async (ctx) => {
    sendJson(ctx, getTaskRunnerStatus());
  });

  router.post("/admin/api/task-processor/start", async (ctx) => {
    sendJson(ctx, startTaskProcessor(), "Started");
  });

  router.post("/admin/api/task-processor/pause", async (ctx) => {
    sendJson(ctx, pauseTaskProcessor(), "Paused");
  });

  router.post("/admin/api/task-callback/start", async (ctx) => {
    sendJson(ctx, startCallbackProcessor(), "Callback started");
  });

  router.post("/admin/api/task-callback/pause", async (ctx) => {
    sendJson(ctx, pauseCallbackProcessor(), "Callback paused");
  });

  router.delete("/admin/api/tasks/:id", async (ctx) => {
    adminDb.deleteTask(normalizeId(ctx.params.id));
    sendJson(ctx, true, "已删除");
  });

  router.get("/admin/api/system-config", async (ctx) => {
    sendJson(ctx, adminDb.getSystemConfig());
  });

  router.put("/admin/api/system-config", async (ctx) => {
    sendJson(ctx, adminDb.updateSystemConfig(getBody(ctx)), "已保存");
  });

  app.use(router.routes());
  app.use(router.allowedMethods());
}
