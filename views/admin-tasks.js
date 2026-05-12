(function () {
  const { h, api, Layout, Badge, Button, LinkButton, Empty, formatDate, label, usePrompts, usePagination } = window.Admin;

  function compact(value) {
    return value === null || value === undefined || value === "" ? "-" : value;
  }

  function firstUrls(value) {
    if (!value) return [];
    return String(value).split(/\n+/).map((item) => item.trim()).filter(Boolean);
  }

  function fileName(value) {
    const text = String(value || "");
    return text.split(/[\\/]/).filter(Boolean).pop() || text || "-";
  }

  function normalizeMaterials(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.filter((item) => item && item.path);
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((item) => item && item.path) : [];
    } catch {
      return String(value).split(/\r?\n/).map((path) => path.trim()).filter(Boolean).map((path) => ({
        type: "file",
        name: fileName(path),
        path,
        source: "path",
      }));
    }
  }

  function materialTypeLabel(type) {
    if (type === "image") return "图片";
    if (type === "video") return "视频";
    return "文件";
  }

  function MetaLine(props) {
    const value = compact(props.value);
    return h("div", { className: "meta-line" }, [
      h("span", { className: "meta-label" }, props.label),
      h("span", { className: "meta-value truncate " + (props.mono ? "mono" : "") }, value),
    ]);
  }

  function App() {
    const prompts = usePrompts();
    const [rows, setRows] = React.useState([]);
    const [loading, setLoading] = React.useState(true);
    const [keyword, setKeyword] = React.useState("");
    const [runtime, setRuntime] = React.useState({ submitRunning: false, callbackRunning: false, activeSubmitCount: 0, activeCallbackCount: 0 });
    const [runtimeBusy, setRuntimeBusy] = React.useState(false);

    async function load(showNotice) {
      setLoading(true);
      try {
        setRows(await api("/admin/api/tasks"));
        await loadRuntime();
        if (showNotice) prompts.notify.success("刷新完成", "任务列表已更新。");
      } catch (err) {
        prompts.notify.error("加载失败", err.message);
      } finally {
        setLoading(false);
      }
    }

    async function loadRuntime() {
      try {
        setRuntime(await api("/admin/api/task-runtime"));
      } catch (err) {
        prompts.notify.error("状态加载失败", err.message);
      }
    }

    React.useEffect(() => {
      load(false);
      const timer = window.setInterval(loadRuntime, 5000);
      return () => window.clearInterval(timer);
    }, []);

    async function toggleTaskProcessor() {
      setRuntimeBusy(true);
      try {
        const endpoint = runtime.submitRunning ? "/admin/api/task-processor/pause" : "/admin/api/task-processor/start";
        const data = await api(endpoint, { method: "POST" });
        setRuntime(data);
        prompts.notify.success(runtime.submitRunning ? "已暂停" : "已开始", runtime.submitRunning ? "任务提交已暂停。" : "任务提交已开始。");
      } catch (err) {
        prompts.notify.error("操作失败", err.message);
      } finally {
        setRuntimeBusy(false);
      }
    }

    async function toggleCallbackProcessor() {
      setRuntimeBusy(true);
      try {
        const endpoint = runtime.callbackRunning ? "/admin/api/task-callback/pause" : "/admin/api/task-callback/start";
        const data = await api(endpoint, { method: "POST" });
        setRuntime(data);
        prompts.notify.success(runtime.callbackRunning ? "已暂停" : "已开始", runtime.callbackRunning ? "任务回调已暂停。" : "任务回调已开始。");
      } catch (err) {
        prompts.notify.error("操作失败", err.message);
      } finally {
        setRuntimeBusy(false);
      }
    }

    async function copyText(text, name) {
      if (!text || text === "-") return prompts.notify.warning("暂无内容", name + "为空，无法复制。");
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text);
        } else {
          const area = document.createElement("textarea");
          area.value = text;
          area.style.position = "fixed";
          area.style.opacity = "0";
          document.body.appendChild(area);
          area.select();
          document.execCommand("copy");
          document.body.removeChild(area);
        }
        prompts.notify.success("复制成功", name + "已复制到剪贴板。");
      } catch (err) {
        prompts.notify.error("复制失败", err.message);
      }
    }

    function CopyLine(props) {
      const value = compact(props.value);
      return h("div", { className: "copy-line" }, [
        h("span", { className: "meta-label" }, props.label),
        h("span", { className: "meta-value truncate mono" }, value),
        h(Button, { icon: "copy", iconOnly: true, title: "复制" + props.name, onClick: () => copyText(props.value, props.name) }),
      ]);
    }

    function MaterialsCell(props) {
      const materials = normalizeMaterials(props.materials);
      if (!materials.length) return h("span", { className: "muted" }, "无素材");
      const allPaths = materials.map((item, index) => `${index + 1}. ${item.path}`).join("\n");
      return h("div", { className: "materials-cell" }, [
        h("div", { className: "materials-head" }, [
          h("span", { className: "materials-count" }, materials.length + " 个素材"),
          h(Button, { icon: "copy", iconOnly: true, title: "复制全部素材路径", onClick: () => copyText(allPaths, "素材路径") }),
        ]),
        h("div", { className: "materials-list" }, materials.slice(0, 2).map((item, index) =>
          h("span", { key: index, className: "material-chip", title: item.path }, [
            h("span", { className: "material-type" }, materialTypeLabel(item.type)),
            h("span", { className: "truncate" }, item.name || fileName(item.path)),
          ])
        )),
        materials.length > 2 ? h("span", { className: "materials-more" }, "+" + (materials.length - 2) + " 个") : null,
        h("div", { className: "materials-tooltip" }, materials.map((item, index) =>
          h("div", { key: index, className: "material-tooltip-row" }, [
            h("span", { className: "material-index" }, String(index + 1)),
            h("div", { className: "material-tooltip-main" }, [
              h("strong", null, (item.name || fileName(item.path)) + " · " + materialTypeLabel(item.type)),
              h("span", { className: "mono" }, item.path),
            ]),
          ])
        )),
      ]);
    }

    async function remove(id) {
      const ok = await prompts.confirm({
        type: "danger",
        title: "删除任务记录",
        message: "删除后该任务的提交状态、生成状态和下载链接都会从后台移除，确认继续吗？",
        confirmText: "删除",
      });
      if (!ok) return;
      try {
        await api("/admin/api/tasks/" + id, { method: "DELETE" });
        prompts.notify.success("删除成功", "任务记录已移除。");
        await load(false);
      } catch (err) {
        prompts.notify.error("删除失败", err.message);
      }
    }

    const filtered = rows.filter((row) => {
      const materialText = normalizeMaterials(row.materials).map((item) => item.path).join(" ");
      const haystack = [
        row.taskId,
        row.memberId,
        row.accountName,
        row.model,
        row.region,
        row.ratio,
        row.resolution,
        row.duration,
        row.prompt,
        row.historyId,
        row.notify,
        materialText,
        row.submitFailReason,
        row.generationFailReason,
        label("taskSubmitStatus", row.submitStatus),
        label("generationStatus", row.generationStatus),
      ].join(" ").toLowerCase();
      return haystack.includes(keyword.toLowerCase());
    });
    const pagination = usePagination(filtered, 10);
    const pageRows = pagination.pageRows;

    return h(Layout, {
      active: "tasks",
      title: "任务管理",
      subtitle: "生成请求会自动写入任务ID、会员ID、素材路径、提交状态、生成状态、失败原因与下载链接。",
      actions: [
        h(Button, { icon: runtime.submitRunning ? "pause" : "play", variant: runtime.submitRunning ? "" : "primary", onClick: toggleTaskProcessor, disabled: runtimeBusy }, runtime.submitRunning ? "暂停任务" : "开始任务"),
        h(Button, { icon: runtime.callbackRunning ? "pause" : "clock", onClick: toggleCallbackProcessor, disabled: runtimeBusy }, runtime.callbackRunning ? "暂停回调" : "任务回调"),
        h(Button, { icon: "refresh", onClick: () => load(true), disabled: loading }, "刷新"),
      ],
    }, [
      h("section", { className: "panel" }, [
        h("div", { className: "toolbar" }, [
          h("input", { className: "search", value: keyword, onChange: (e) => setKeyword(e.target.value), placeholder: "搜索任务ID、会员ID、账号、素材、historyId或提示词" }),
          h("span", { className: "muted" }, "共 " + filtered.length + " 条 · 提交中 " + (runtime.activeSubmitCount || 0) + " · 回调中 " + (runtime.activeCallbackCount || 0)),
        ]),
        pageRows.length ? h("div", { className: "table-wrap task-table-wrap" }, h("table", { className: "task-table" }, [
          h("thead", null, h("tr", null, [
            "任务编号",
            "会员/账号",
            "模型/区域",
            "参数",
            "素材",
            "提示词",
            "状态",
            "下载/时间",
            "操作",
          ].map((text) => h("th", { key: text }, text)))),
          h("tbody", null, pageRows.map((row) => {
            const urls = firstUrls(row.downloadUrl);
            const showGeneration = Number(row.submitStatus) === 1 && Number(row.generationStatus) !== 0;
            const prompt = compact(row.prompt);
            const hasSubmitReason = compact(row.submitFailReason) !== "-";
            const hasGenerationReason = showGeneration && compact(row.generationFailReason) !== "-";
            return h("tr", { key: row.id }, [
              h("td", null, h("div", { className: "task-meta" }, [
                h(CopyLine, { label: "任务ID", value: row.taskId, name: "任务ID" }),
                h(CopyLine, { label: "history", value: row.historyId, name: "historyId" }),
                h(CopyLine, { label: "notify", value: row.notify, name: "notify" }),
              ])),
              h("td", null, h("div", { className: "task-meta" }, [
                h(MetaLine, { label: "会员ID", value: row.memberId, mono: true }),
                h(MetaLine, { label: "账号", value: row.accountName }),
              ])),
              h("td", null, h("div", { className: "task-meta" }, [
                h(MetaLine, { label: "模型", value: row.model }),
                h(MetaLine, { label: "区域", value: row.region }),
              ])),
              h("td", null, h("div", { className: "task-meta" }, [
                h(MetaLine, { label: "比例", value: row.ratio }),
                h(MetaLine, { label: "分辨率", value: row.resolution }),
                h(MetaLine, { label: "时长", value: row.duration ? row.duration + "s" : "-" }),
              ])),
              h("td", null, h(MaterialsCell, { materials: row.materials })),
              h("td", null, h("div", { className: "prompt-cell" }, [
                h("span", { className: "prompt-preview" }, prompt),
                h("span", { className: "prompt-tooltip" }, prompt),
                h(Button, { icon: "copy", iconOnly: true, title: "复制提示词", onClick: () => copyText(row.prompt, "提示词") }),
              ])),
              h("td", null, h("div", { className: "task-status-stack" }, [
                h(Badge, { value: row.submitStatus, dict: "taskSubmitStatus" }),
                showGeneration ? h(Badge, { value: row.generationStatus, dict: "generationStatus" }) : null,
                hasSubmitReason ? h("span", { className: "status-reason" }, "提交：" + row.submitFailReason) : null,
                hasGenerationReason ? h("span", { className: "status-reason" }, "生成：" + row.generationFailReason) : null,
              ])),
              h("td", null, h("div", { className: "task-meta" }, [
                Number(row.generationStatus) === 2 && urls.length
                  ? h("div", { className: "download-cell" }, urls.slice(0, 4).map((url, index) =>
                      h(LinkButton, { key: url, href: url, icon: "download", iconOnly: true, title: "下载 " + (index + 1) })
                    ))
                  : h(MetaLine, { label: "下载", value: "-" }),
                h(MetaLine, { label: "创建", value: formatDate(row.createdAt) }),
                h(MetaLine, { label: "生成", value: formatDate(row.generatedAt) }),
              ])),
              h("td", null, h(Button, { icon: "trash", iconOnly: true, variant: "danger", title: "删除", onClick: () => remove(row.id) })),
            ]);
          })),
        ])) : h(Empty, { loading }),
        h(pagination.PaginationBar),
      ]),
      h(prompts.PromptHost),
    ]);
  }

  ReactDOM.createRoot(document.getElementById("root")).render(h(App));
})();
