import { createHash } from "crypto";
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
  page: Page;
  lastUsed: number;
}

const SESSION_TTL_MS = 10 * 60 * 1000;

const BLOCKED_RESOURCE_TYPES = new Set(["image", "font", "media"]);
const SDK_SCRIPT_HOSTS = [
  "vlabstatic.com",
  "bytescm.com",
  "jianying.com",
  "capcutcdn-us.com",
  "capcutstatic.com",
];
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

  static getInstance() {
    if (!BrowserService.instance) BrowserService.instance = new BrowserService();
    return BrowserService.instance;
  }

  async request(options: BrowserRequestOptions): Promise<AxiosResponse> {
    const session = await this.getOrCreateSession(options);
    const requestUrl = appendParams(options.url, options.params || {});
    const requestBody = stringifyBody(options.data);
    const headers = normalizeHeaders(options.headers || {});
    const signHeaders = getSignHeaders(requestBody);
    const timeout = options.timeout || 45000;

    logger.info(`浏览器代理请求: ${options.method.toUpperCase()} ${requestUrl}`);

    const result = (await session.page.evaluate(
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
          const mergedHeaders = { ...headers, ...signature };
          console.info(
            `[BrowserService] sign result X-Bogus=${signedUrl.searchParams.has("X-Bogus") ? "yes" : "no"}, X-Gnarly=${signedUrl.searchParams.has("X-Gnarly") ? "yes" : "no"}`
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
      )) as {
        status: number;
        statusText: string;
        headers: Record<string, string>;
        data: any;
      };

    session.lastUsed = Date.now();
    return {
      ...result,
      config: {},
      request: null,
    } as AxiosResponse;
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
    await addCookies(context, [baseUrl, new URL(referer)], String(headers.Cookie || headers.cookie || ""));

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
    return { context, page, lastUsed: Date.now() };
  }

  private async getOrCreateSession(options: BrowserRequestOptions): Promise<BrowserSession> {
    const cached = this.sessions.get(options.sessionId);
    if (cached) {
      try {
        await cached.page.evaluate(() => true);
        cached.lastUsed = Date.now();
        logger.info(`BrowserService 复用会话: ${options.sessionId}`);
        return cached;
      } catch {
        this.sessions.delete(options.sessionId);
        await this.closeContext(cached.context);
      }
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
        logger.info(`BrowserService 清理过期会话: ${id}`);
        this.sessions.delete(id);
        await this.closeContext(session.context);
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
    return launch({
      headless: false,
      executablePath: "C:\\Users\\Administrator\\.cloakbrowser\\chromium-146.0.7680.177.4\\chrome.exe",
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
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
      await page.waitForFunction(() => !!(window as any).byted_acrawler?.frontierSign, {
        timeout: 15000,
      }).catch(() => undefined);
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
      await page.waitForTimeout(800);
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

async function addCookies(context: BrowserContext, urls: URL[], cookieHeader: string): Promise<void> {
  const hosts = [...new Map(urls.map((url) => [url.hostname, url])).values()];
  const cookies = hosts.flatMap((url) =>
    cookieHeader
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf("=");
        if (separator <= 0) return null;
        return {
          name: part.slice(0, separator),
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
