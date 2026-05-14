/**
 * 真实浏览器请求捕获脚本
 * 用于抓取官网提交时的真实请求头、Cookie、签名参数等信息
 * 运行后会打开一个真实浏览器窗口，请在其中登录并提交一次生成请求
 */
import { launch } from "cloakbrowser";
import fs from "fs";

const TARGET_URL = "https://dreamina.capcut.com/ai-tool/generate";
const CAPTURE_PATH_KEYWORD = "/mweb/v1/aigc_draft/generate";
const OUTPUT_FILE = "captured-request.json";

async function main() {
  console.log("正在启动真实 Chrome 浏览器...");
  const browser = await launch({
    headless: false,
    args: [
      "--start-maximized",
      "--disable-web-security",
      "--no-first-run",
    ],
  });

  const context = await browser.newContext({
    viewport: null,
  });

  const page = await context.newPage();

  let captured = null;

  // 捕获请求
  page.on("request", (request) => {
    if (!request.url().includes(CAPTURE_PATH_KEYWORD)) return;
    const url = new URL(request.url());
    const params = {};
    for (const [k, v] of url.searchParams.entries()) params[k] = v;

    captured = {
      method: request.method(),
      url: request.url(),
      urlParams: params,
      headers: request.headers(),
      postData: request.postData(),
      timestamp: new Date().toISOString(),
    };

    console.log("\n============================================================");
    console.log("✅ 已捕获到生成请求！");
    console.log("URL:", request.url());
    console.log("\n--- 请求头 (Headers) ---");
    const h = request.headers();
    const importantHeaders = [
      "cookie", "user-agent", "referer", "origin", "content-type",
      "x-bogus", "x-gnarly", "x-ms-stub", "sign", "sign-ver",
      "device-time", "appvr", "pf", "appid", "lan", "loc",
      "sec-ch-ua", "sec-ch-ua-platform", "sec-ch-ua-mobile",
      "accept-language", "app-sdk-version",
    ];
    for (const key of importantHeaders) {
      if (h[key]) {
        const val = key === "cookie" ? h[key].substring(0, 120) + "..." : h[key];
        console.log(`  ${key}: ${val}`);
      }
    }
    console.log("\n--- URL 参数 ---");
    console.log(JSON.stringify(params, null, 2));
    console.log("\n--- 请求体 (Body) 摘要 ---");
    try {
      const body = JSON.parse(request.postData() || "{}");
      console.log(JSON.stringify(body, null, 2).substring(0, 500));
    } catch {
      console.log(request.postData()?.substring(0, 200));
    }
    console.log("============================================================\n");

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(captured, null, 2), "utf-8");
    console.log(`📄 完整捕获数据已保存到: ${OUTPUT_FILE}`);
  });

  // 捕获响应
  page.on("response", async (response) => {
    if (!response.url().includes(CAPTURE_PATH_KEYWORD)) return;
    try {
      const body = await response.json();
      console.log("\n--- 响应数据 ---");
      console.log(JSON.stringify(body, null, 2).substring(0, 800));
    } catch {}
  });

  console.log(`正在导航到: ${TARGET_URL}`);
  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

  console.log("\n🌐 浏览器已打开，请：");
  console.log("  1. 在浏览器中登录你的账号");
  console.log("  2. 输入一段提示词，点击「生成」按钮");
  console.log("  3. 脚本会自动捕获请求信息并输出到控制台");
  console.log("  4. 捕获完成后按 Ctrl+C 退出");
  console.log("\n等待你在浏览器中提交... (最多等待10分钟)\n");

  await page.waitForTimeout(600000);
  await browser.close();
}

main().catch((err) => {
  console.error("错误:", err.message);
  process.exit(1);
});
