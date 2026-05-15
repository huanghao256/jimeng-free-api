import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AxiosResponse } from "axios";
import {
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
  type Route,
} from "playwright-core";

import logger from "@/lib/logger.ts";
import { launch } from "cloakbrowser";
type HeaderValue = any;

export interface BrowserRequestOptions {
  method: string;
  url: string;
  params?: Record<string, any>;
  headers?: Record<string, HeaderValue>;
  data?: any;
  sessionId: string;
  proxyUrl?: string | null;
  timeout?: number;
  referer?: string;
}

interface BrowserSession {
  context: BrowserContext;
  page: Page | null;
  lastUsed: number;
  pageLastUsed: number;
  hasRetried?: boolean;
}

// Context 存活时长（保留设备指纹 Cookie）
const SESSION_TTL_MS = 10 * 60 * 1000;
// Page 空闲关闭时长（释放内存；重建 Page 时设备已注册，10s 等待即可通过 shark）
const PAGE_IDLE_TTL_MS = 3 * 60 * 1000;

const BLOCKED_RESOURCE_TYPES = new Set(["image", "font", "media"]);
const SDK_SCRIPT_HOSTS = [
  "vlabstatic.com",
  "bytescm.com",
  "jianying.com",
  "capcutcdn-us.com",
  "capcutstatic.com",
  // ByteDance 常见 CDN（风控/指纹 SDK 可能从这些域名加载脚本）
  "bytedance.com",
  "byteimg.com",
  "ibytedtos.com",
  "bytedtos.com",
  "snssdk.com",
  "pstatp.com",
  "douyinstatic.com",
  "toutiao.com",
  "byted-cg.com",
  "capcut.com",
  "capcut.net",
  "dreamina.com",
];

// 注入 Cookie 时要跳过的字段（这些应由 SDK 实时生成，不应预注入旧值）
const FINGERPRINT_COOKIE_NAMES = new Set([
  "msToken",
  "tt_chain_token",
]);

// 需要持久化到磁盘以保持设备指纹一致的 Cookie 名（跨浏览器重启复用）
const FINGERPRINT_PERSIST_NAMES = ["_tea_web_id", "ttwid", "odin_tt", "dm_auid"];

// 持久化指纹状态的有效期（30 天）
const FINGERPRINT_STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface FingerprintState {
  savedAt: number;
  cookies: Record<string, string>;
}
const FORBIDDEN_FETCH_HEADERS = new Set([
  "accept-charset",
  "accept-encoding",
  "access-control-request-headers",
  "access-control-request-method",
  "connection",
  "content-length",
  "cookie",
  "date",
  "dnt",
  "expect",
  "host",
  "keep-alive",
  "origin",
  "permissions-policy",
  "referer",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
]);

export default class BrowserService {
  private static instance?: BrowserService;
  private browser?: Browser;
  private launching?: Promise<Browser>;
  private sessions = new Map<string, BrowserSession>();
  private cleanupTimer?: ReturnType<typeof setInterval>;

  // ── 指纹持久化 ──────────────────────────────────────────────────────────────
  private getFingerprintPath(sessionId: string): string {
    const hash = createHash("md5").update(sessionId).digest("hex").slice(0, 16);
    const dir = join(tmpdir(), "bs-fingerprints");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return join(dir, `${hash}.json`);
  }

  private loadFingerprint(sessionId: string): FingerprintState | null {
    try {
      const file = this.getFingerprintPath(sessionId);
      logger.info(`BrowserService 查找指纹文件: ${file}`);
      if (!existsSync(file)) {
        logger.info("BrowserService 指纹文件不存在，将重新生成");
        return null;
      }
      const state: FingerprintState = JSON.parse(readFileSync(file, "utf-8"));
      if (Date.now() - state.savedAt > FINGERPRINT_STATE_TTL_MS) {
        logger.info("BrowserService 指纹状态已过期，将重新生成");
        return null;
      }
      logger.info(`BrowserService 已加载持久化指纹: ${Object.keys(state.cookies).join(", ")}`);
      return state;
    } catch { return null; }
  }

  private saveFingerprint(sessionId: string, cookies: Record<string, string>): void {
    try {
      // _tea_web_id 一旦注册到服务端就不能变（多设备 ID 会触发 shark 账号异常）
      // 若磁盘已有注册过的值，强制保留原值，防止 SDK 重新生成后覆盖导致设备 ID 漂移
      const existing = this.loadFingerprint(sessionId);
      const lockedWebId = existing?.cookies["_tea_web_id"];
      const finalCookies = lockedWebId
        ? { ...cookies, _tea_web_id: lockedWebId }
        : cookies;
      const state: FingerprintState = { savedAt: Date.now(), cookies: finalCookies };
      writeFileSync(this.getFingerprintPath(sessionId), JSON.stringify(state), "utf-8");
      logger.info(`BrowserService 指纹状态已持久化: ${Object.keys(finalCookies).join(", ")}`);
    } catch (err: any) {
      logger.warn(`BrowserService 保存指纹失败: ${err.message}`);
    }
  }

  private deleteFingerprint(sessionId: string): void {
    try {
      const file = this.getFingerprintPath(sessionId);
      if (existsSync(file)) {
        unlinkSync(file);
        logger.info(`BrowserService 指纹文件已删除（设备被 shark 标记，下次重新注册）: ${sessionId}`);
      }
    } catch (err: any) {
      logger.warn(`BrowserService 删除指纹失败: ${err.message}`);
    }
  }

  static getInstance() {
    if (!BrowserService.instance) BrowserService.instance = new BrowserService();
    return BrowserService.instance;
  }

  async request(options: BrowserRequestOptions): Promise<AxiosResponse> {
    // 允许在当前请求内自动重置设备一次：
    // 若旧设备三次均 4013，立即删指纹、换新设备重试，避免误判为失败返回给调用方
    let allowDeviceReset = true;

    while (true) {
      const session = await this.getOrCreateSession(options);
      const page = session.page!;
      try {
        let result = await this.sendXhr(page, options);

        // 首次 4013：等待服务端完成设备注册后重试
        if (result.data?.ret === "-6" && result.data?.data?.fail_code === "4013" && !session.hasRetried) {
          session.hasRetried = true;
          logger.info("BrowserService 风控拒绝(4013)，等待设备注册后重试 #1（5s）...");
          await page.waitForTimeout(5000);
          result = await this.sendXhr(page, options);
        }

        // 第二次 4013：再等更长时间让注册流程完成
        if (result.data?.ret === "-6" && result.data?.data?.fail_code === "4013") {
          logger.warn("BrowserService 重试#1仍4013，等待设备注册后重试 #2（12s）...");
          await page.waitForTimeout(12000);
          result = await this.sendXhr(page, options);
        }

        // 三次全失败：设备 ID 被 shark 标记，删除指纹并销毁 Session
        if (result.data?.ret === "-6" && result.data?.data?.fail_code === "4013") {
          logger.warn("BrowserService 三次均4013，删除污染指纹并销毁会话");
          this.deleteFingerprint(options.sessionId);
          this.sessions.delete(options.sessionId);
          this.closeContext(session.context).catch(() => undefined);

          if (allowDeviceReset) {
            allowDeviceReset = false;
            logger.info("BrowserService 自动切换新设备重试（新设备注册约需 30s）...");
            continue; // 回到 while 顶部，用新设备重走完整流程
          }
          logger.warn("BrowserService 新设备仍 4013，放弃重试");
        }

        session.lastUsed = Date.now();
        session.pageLastUsed = Date.now();
        return { ...result, config: {}, request: null } as AxiosResponse;
      } finally {
        session.hasRetried = false;
      }
    }
  }

  private async sendXhr(
    page: Page,
    options: BrowserRequestOptions,
  ): Promise<{ status: number; statusText: string; headers: Record<string, string>; data: any }> {
    const requestUrl = appendParams(options.url, options.params || {});
    const requestBody = stringifyBody(options.data);
    const headers = normalizeHeaders(options.headers || {});
    const signHeaders = getSignHeaders(requestBody);
    const timeout = options.timeout || 45000;

    logger.info(`浏览器代理请求: ${options.method.toUpperCase()} ${requestUrl}`);

    return (await page.evaluate(
        async ({ method, url, headers, signInputHeaders, body, timeout }) => {
          const acrawler = (window as any).byted_acrawler;
          let signature: Record<string, string> = {};
          if (acrawler?.frontierSign) {
            const candidates = [
              { url, method, body, headers: { ...headers, ...signInputHeaders } },
              { url, method, data: body, headers: { ...headers, ...signInputHeaders } },
              url,
            ];
            for (const candidate of candidates) {
              try {
                const signed = await acrawler.frontierSign(candidate);
                if (signed && typeof signed === "object") {
                  signature = Object.fromEntries(
                    Object.entries(signed).map(([key, value]) => [key, String(value)])
                  );
                  if (signature["X-Bogus"] || signature["X-Gnarly"]) break;
                }
              } catch {
                // Try the next supported signature shape.
              }
            }
          }

          const signedUrl = new URL(url);
          if (signature["X-Bogus"]) {
            signedUrl.searchParams.set("X-Bogus", signature["X-Bogus"]);
            delete signature["X-Bogus"];
          }
          if (signature["X-Gnarly"]) {
            signedUrl.searchParams.set("X-Gnarly", signature["X-Gnarly"]);
            delete signature["X-Gnarly"];
          }
          // msToken 由 frontierSign 生成，必须放到 URL 参数（不能放 Header），服务端以此校验签名
          if (signature["msToken"]) {
            signedUrl.searchParams.set("msToken", signature["msToken"]);
            delete signature["msToken"];
          }
          // 将浏览器真实的 _tea_web_id 作为 webId 写入 URL（国际站需要此参数）
          if (!signedUrl.searchParams.has("webId")) {
            const teaWebId = document.cookie
              .split(";")
              .map((p) => p.trim())
              .find((p) => p.startsWith("_tea_web_id="))
              ?.split("=")[1];
            if (teaWebId) signedUrl.searchParams.set("webId", teaWebId);
          }
          // 尝试从 SDK 或 localStorage 获取设备 ID（did header）
          const did = (() => {
            try {
              const ac = (window as any).byted_acrawler;
              if (typeof ac?.getDeviceId === "function") return String(ac.getDeviceId());
              if (typeof ac?.getAcDid === "function") return String(ac.getAcDid());
              return localStorage.getItem("_d2id") || localStorage.getItem("byted_acrawler_device_id") || "";
            } catch { return ""; }
          })();
          const mergedHeaders: Record<string, string> = { ...headers, ...signature };
          if (did) mergedHeaders["did"] = did;
          console.info(
            `[BrowserService] sign result X-Bogus=${signedUrl.searchParams.has("X-Bogus") ? "yes" : "no"}, X-Gnarly=${signedUrl.searchParams.has("X-Gnarly") ? "yes" : "no"}, msToken=${signedUrl.searchParams.has("msToken") ? "yes" : "no"}, webId=${signedUrl.searchParams.has("webId") ? "yes" : "no"}, did=${did ? "yes" : "no"}`
          );

          return await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open(method, signedUrl.toString(), true);
            xhr.withCredentials = true;
            xhr.timeout = timeout;

            for (const [name, value] of Object.entries(mergedHeaders)) {
              try {
                xhr.setRequestHeader(name, String(value));
              } catch {
                // Browser-forbidden headers are already filtered, but keep the request resilient.
              }
            }

            xhr.onload = () => {
              const text = xhr.responseText || "";
              let parsed: any = text;
              try {
                parsed = text ? JSON.parse(text) : null;
              } catch {
                parsed = text;
              }

              resolve({
                status: xhr.status,
                statusText: xhr.statusText,
                headers: Object.fromEntries(
                  xhr
                    .getAllResponseHeaders()
                    .trim()
                    .split(/\r?\n/)
                    .filter(Boolean)
                    .map((line) => {
                      const separator = line.indexOf(":");
                      return [
                        line.slice(0, separator).trim().toLowerCase(),
                        line.slice(separator + 1).trim(),
                      ];
                    })
                ),
                data: parsed,
              });
            };
            xhr.onerror = () => reject(new Error("Browser XMLHttpRequest failed"));
            xhr.ontimeout = () => reject(new Error("Browser XMLHttpRequest timeout"));
            xhr.send(body);
          });
        },
        {
          method: options.method.toUpperCase(),
          url: requestUrl,
          headers,
          signInputHeaders: signHeaders,
          body: requestBody,
          timeout,
        }
      )) as { status: number; statusText: string; headers: Record<string, string>; data: any };
  }

  private async createSession(options: BrowserRequestOptions): Promise<BrowserSession> {
    const browser = await this.ensureBrowser();
    const baseUrl = new URL(options.url);
    const referer = options.referer || baseUrl.origin;
    const headers = options.headers || {};
    const contextOptions: BrowserContextOptions = {
      bypassCSP: true,
      locale: String(headers["Accept-language"] || headers["Accept-Language"] || "zh-CN"),
      userAgent: String(headers["User-Agent"] || headers["user-agent"] || ""),
      viewport: { width: 1366, height: 768 },
      extraHTTPHeaders: normalizeContextHeaders(headers),
      ...(options.proxyUrl ? { proxy: parsePlaywrightProxy(options.proxyUrl) } : {}),
    };

    const context = await browser.newContext(contextOptions);
    await context.route("**/*", (route) => this.routeRequest(route, baseUrl.hostname));

    // 第一步：注入会话认证 Cookie（包含 generateCookie 生成的随机 _tea_web_id 作为基础值）
    await addCookies(context, [baseUrl, new URL(referer)], String(headers.Cookie || headers.cookie || ""), FINGERPRINT_COOKIE_NAMES);

    // 第二步：若磁盘有持久化设备 ID，只覆盖 _tea_web_id，其余 Cookie 由用户 Cookie header 提供
    // 不注入磁盘上的 ttwid 等——SDK 每次运行会刷新它们，用旧值会覆盖用户传入的最新值导致 shark 失败
    const savedFingerprint = this.loadFingerprint(options.sessionId);
    if (savedFingerprint && savedFingerprint.cookies["_tea_web_id"]) {
      const webId = savedFingerprint.cookies["_tea_web_id"];
      await addCookies(context, [baseUrl, new URL(referer)], `_tea_web_id=${webId}`);
      logger.info(`BrowserService 已覆盖为持久化指纹: _tea_web_id=${webId.slice(0, 10)}...`);
    }

    // 记录注入后的 _tea_web_id（页面加载前）
    const cookiesBefore = await context.cookies();
    const webIdBefore = cookiesBefore.find((c) => c.name === "_tea_web_id")?.value ?? "";
    logger.info(`BrowserService 页面加载前 _tea_web_id: ${webIdBefore.slice(0, 15) || "（未注入）"}`);

    const page = await this.createPageInContext(context, options);

    // 首次运行（无持久化指纹）：设备 ID 全新，shark 系统需要时间在服务端完成设备注册。
    // 实测本地已注册设备 ~21s 后能通过；全新设备需更长时间，额外等待 30s 以确保注册完成。
    if (!savedFingerprint) {
      logger.info("BrowserService 新设备首次运行，等待 30s 让 shark 完成服务端设备注册...");
      await page.waitForTimeout(30000);
      logger.info("BrowserService 新设备等待完成，开始 API 请求");
    }

    // 记录 SDK 运行后的 _tea_web_id，判断是否被重新生成
    const cookiesAfter = await context.cookies();
    const webIdAfter = cookiesAfter.find((c) => c.name === "_tea_web_id")?.value ?? "";
    logger.info(
      `BrowserService 页面加载后 _tea_web_id: ${webIdAfter.slice(0, 15) || "（未生成）"}` +
      (webIdBefore && webIdAfter && webIdBefore !== webIdAfter ? " ⚠ SDK已重新生成，原值失效" : " ✓ 与注入值一致")
    );

    return { context, page, lastUsed: Date.now(), pageLastUsed: Date.now() };
  }

  // 在已有 Context 中新建 Page 并完成 SDK 初始化（Cookie 由 Context 自动继承）
  private async createPageInContext(
    context: BrowserContext,
    options: BrowserRequestOptions,
  ): Promise<Page> {
    const referer = options.referer || new URL(options.url).origin;
    const page = await context.newPage();
    page.on("request", (request) => {
      if (!request.url().includes("/mweb/v1/aigc_draft/generate")) return;
      const requestHeaders = request.headers();
      const requestUrl = new URL(request.url());
      logger.info(
        `浏览器代理签名状态: X-Bogus=${requestUrl.searchParams.has("X-Bogus") || requestHeaders["x-bogus"] ? "yes" : "no"}, X-Gnarly=${requestUrl.searchParams.has("X-Gnarly") || requestHeaders["x-gnarly"] ? "yes" : "no"}`
      );
    });
    page.on("console", (message) => {
      const text = message.text();
      if (text.startsWith("[BrowserService]")) logger.info(text);
    });
    await this.preparePage(page, referer, options.timeout);

    // 读取 SDK 初始化后的指纹 Cookie 并持久化（每次建 Page 后刷新一次）
    try {
      const allCookies = await context.cookies();
      const fingerprintCookies = Object.fromEntries(
        allCookies
          .filter((c) => FINGERPRINT_PERSIST_NAMES.includes(c.name) && c.value)
          .map((c) => [c.name, c.value])
      );
      if (Object.keys(fingerprintCookies).length > 0) {
        this.saveFingerprint(options.sessionId, fingerprintCookies);
      }
    } catch (err: any) {
      logger.warn(`BrowserService 读取指纹 Cookie 失败: ${err.message}`);
    }

    return page;
  }

  private async getOrCreateSession(options: BrowserRequestOptions): Promise<BrowserSession> {
    const cached = this.sessions.get(options.sessionId);
    if (cached) {
      const contextAlive = await cached.context.cookies().then(() => true).catch(() => false);
      if (contextAlive) {
        const pageAlive = cached.page !== null && !cached.page.isClosed();
        if (pageAlive) {
          // Page 仍存活：直接复用，无需重新导航和初始化 SDK
          logger.info(`BrowserService 复用已存在 Page（无需重建）: ${options.sessionId}`);
          cached.lastUsed = Date.now();
          cached.pageLastUsed = Date.now();
          return cached;
        }
        // Page 空闲超时或意外关闭，重建 Page；设备已注册，10s 等待足够通过 shark
        logger.info(`BrowserService 重建 Page（复用 Context）: ${options.sessionId}`);
        cached.page = await this.createPageInContext(cached.context, options);
        logger.info("BrowserService 页面重建后等待 10s 让 shark 处理新 msToken...");
        await cached.page.waitForTimeout(10000);
        cached.lastUsed = Date.now();
        cached.pageLastUsed = Date.now();
        return cached;
      }
      // Context 已失效，完整重建
      this.sessions.delete(options.sessionId);
      await this.closeContext(cached.context);
    }

    const session = await this.createSession(options);
    this.sessions.set(options.sessionId, session);
    this.ensureCleanupScheduled();
    return session;
  }

  private ensureCleanupScheduled(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => { this.cleanupStaleSessions(); }, 60_000);
  }

  private async cleanupStaleSessions(): Promise<void> {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastUsed > SESSION_TTL_MS) {
        // Context 超时：整体销毁（含 Page）
        logger.info(`BrowserService 清理过期会话: ${id}`);
        this.sessions.delete(id);
        await this.closeContext(session.context);
      } else if (session.page && !session.page.isClosed() && now - session.pageLastUsed > PAGE_IDLE_TTL_MS) {
        // Page 空闲超时：只关 Page 释放内存，Context（设备 Cookie）继续保留
        logger.info(`BrowserService 关闭空闲 Page（节省内存）: ${id}`);
        session.page.close().catch(() => undefined);
        session.page = null;
      }
    }
    if (this.sessions.size === 0 && this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (this.launching) return this.launching;

    this.launching = this.launchBrowser()
      .then((browser) => {
        this.browser = browser;
        this.launching = undefined;
        logger.info("BrowserService CloakBrowser Chromium 已启动");
        return browser;
      })
      .catch((error) => {
        this.launching = undefined;
        throw error;
      });

    return this.launching;
  }

  private async launchBrowser(): Promise<Browser> {
    const headless = process.env.BROWSER_HEADLESS === "true";
    return launch({
      headless,
      launchOptions:{
        executablePath: "C:\\Users\\Administrator\\.cloakbrowser\\chromium-146.0.7680.177.4\\chrome.exe",
      },
      args: [
        "--disable-background-networking",
        "--disable-background-timer-throttling",
        "--disable-dev-shm-usage",
        "--disable-extensions",
        "--disable-renderer-backgrounding",
        "--no-first-run",
        "--no-sandbox",
      ],
    }) as unknown as Browser;
  }

  private async preparePage(page: Page, referer: string, timeout = 45000): Promise<void> {
    try {
      await page.goto(referer, {
        waitUntil: "domcontentloaded",
        timeout,
      });
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);

      // 等待 acrawler SDK 加载并初始化签名函数
      const sdkReady = await page.waitForFunction(
        () => !!(window as any).byted_acrawler?.frontierSign,
        undefined,
        { timeout: 20000 }
      ).then(() => true).catch(() => false);
      logger.info(`BrowserService acrawler SDK ${sdkReady ? "已就绪" : "未就绪（无签名功能）"}`);

      // 等待 SDK 生成 msToken（_tea_web_id 已在 createSession 预注入，无需等待）
      const riskCookiesReady = await page.waitForFunction(
        () => document.cookie.includes("msToken="),
        undefined,
        { timeout: 15000 }
      ).then(() => true).catch(() => false);
      logger.info(`BrowserService 风控 Cookie ${riskCookiesReady ? "已就绪" : "未完全就绪，继续尝试"}`);

      // 等待 odin_tt（国内站设备级认证 Cookie），国际站不会生成，超时后继续
      const odinttReady = await page.waitForFunction(
        () => document.cookie.includes("odin_tt="),
        undefined,
        { timeout: 10000 }
      ).then(() => true).catch(() => false);
      logger.info(`BrowserService odin_tt ${odinttReady ? "已就绪" : "未就绪（国际站无此 Cookie）"}`);

      // 读取 SDK 生成的 _tea_web_id 并反馈给 acrawler，确保签名使用正确的 WebID
      await page.evaluate(() => {
        const acrawler = (window as any).byted_acrawler;
        if (!acrawler) return;
        const webId = document.cookie
          .split(";")
          .map((part) => part.trim())
          .find((part) => part.startsWith("_tea_web_id="))
          ?.split("=")[1];
        if (webId) {
          acrawler.setTTWebid?.(webId);
          acrawler.setTTWebidV2?.(webId);
          acrawler.setTTWid?.(webId);
        }
      }).catch(() => undefined);

      logger.info(`BrowserService 会话初始化完成: ${referer}`);
    } catch (error: any) {
      logger.warn(`BrowserService 会话初始化未完全完成，将继续尝试提交: ${error.message}`);
    }
  }

  private routeRequest(route: Route, apiHost: string): void {
    const request = route.request();
    const resourceType = request.resourceType();
    const requestUrl = request.url();

    if (requestUrl.startsWith("data:") || requestUrl.startsWith("blob:")) {
      route.continue();
      return;
    }

    let hostname = "";
    try {
      hostname = new URL(requestUrl).hostname;
    } catch {
      route.abort();
      return;
    }

    if (resourceType === "stylesheet") {
      route.fulfill({
        status: 200,
        contentType: "text/css",
        body: "",
      });
      return;
    }

    if (BLOCKED_RESOURCE_TYPES.has(resourceType)) {
      route.abort();
      return;
    }

    if (resourceType === "script" && !isAllowedSdkHost(hostname)) {
      route.abort();
      return;
    }

    if (["document", "xhr", "fetch"].includes(resourceType)) {
      route.continue();
      return;
    }

    if (hostname === apiHost || isAllowedSdkHost(hostname)) {
      route.continue();
      return;
    }

    route.abort();
  }

  private async closeContext(context: BrowserContext): Promise<void> {

    try {
      await context.close();
      logger.info("BrowserService 会话已关闭");
    } catch (error: any) {
      logger.warn(`BrowserService 关闭会话失败: ${error.message}`);
    }
  }
}

function appendParams(url: string, params: Record<string, any>): string {
  const target = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) target.searchParams.append(key, String(item));
      continue;
    }
    target.searchParams.set(key, String(value));
  }
  return target.toString();
}

function normalizeHeaders(headers: Record<string, HeaderValue>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    const lowerName = name.toLowerCase();
    if (FORBIDDEN_FETCH_HEADERS.has(lowerName)) continue;
    if (lowerName.startsWith("proxy-") || lowerName.startsWith("sec-")) continue;
    normalized[name] = String(value);
  }
  if (!Object.keys(normalized).some((name) => name.toLowerCase() === "content-type")) {
    normalized["Content-Type"] = "application/json";
  }
  return normalized;
}

function getSignHeaders(body?: string): Record<string, string> {
  if (body === undefined) return {};
  return {
    "X-MS-STUB": createHash("md5").update(body).digest("hex").toUpperCase(),
  };
}

function stringifyBody(data: any): string | undefined {
  if (data === undefined) return undefined;
  return typeof data === "string" ? data : JSON.stringify(data);
}

function normalizeContextHeaders(headers: Record<string, HeaderValue>): Record<string, string> {
  const allowed = ["Accept-language", "Accept-Language"];
  const result: Record<string, string> = {};
  for (const name of allowed) {
    const value = headers[name];
    if (value !== undefined && value !== null) result[name] = String(value);
  }
  return result;
}

async function addCookies(
  context: BrowserContext,
  urls: URL[],
  cookieHeader: string,
  skipNames?: Set<string>
): Promise<void> {
  const hosts = [...new Map(urls.map((url) => [url.hostname, url])).values()];
  const cookies = hosts.flatMap((url) =>
    cookieHeader
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf("=");
        if (separator <= 0) return null;
        const name = part.slice(0, separator);
        if (skipNames?.has(name)) return null;
        return {
          name,
          value: part.slice(separator + 1),
          domain: url.hostname,
          path: "/",
          secure: url.protocol === "https:",
          sameSite: "Lax" as const,
        };
      })
      .filter((cookie): cookie is NonNullable<typeof cookie> => !!cookie)
  );

  if (cookies.length) await context.addCookies(cookies);
}

function isAllowedSdkHost(hostname: string): boolean {
  return SDK_SCRIPT_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}


function parsePlaywrightProxy(proxyUrl: string): BrowserContextOptions["proxy"] {
  try {
    const parsed = new URL(proxyUrl);
    const server = `${parsed.protocol}//${parsed.host}`;
    return {
      server,
      ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
      ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    };
  } catch {
    return { server: proxyUrl };
  }
}
