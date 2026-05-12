(function () {
  const h = React.createElement;
  const dicts = window.AdminDictionaries;

  const navItems = [
    { key: "socks5", href: "/admin/socks5", label: "Socket5管理", icon: "S5" },
    { key: "tasks", href: "/admin/tasks", label: "任务管理", icon: "TM" },
    { key: "members", href: "/admin/members", label: "会员账号", icon: "MB" },
    { key: "system", href: "/admin/system", label: "系统配置", icon: "CF" },
  ];

  async function api(path, options) {
    const hasBody = options && Object.prototype.hasOwnProperty.call(options, "body");
    const response = await fetch(path, {
      headers: hasBody ? { "Content-Type": "application/json; charset=utf-8" } : undefined,
      ...options,
      body: hasBody ? JSON.stringify(options.body || {}) : undefined,
    });
    const payload = await response.json();
    if (!response.ok || payload.code !== 0) {
      throw new Error(payload.message || "请求失败");
    }
    return payload.data;
  }

  function icon(name) {
    const common = {
      width: 16,
      height: 16,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 2,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
    };
    const paths = {
      plus: [h("path", { d: "M12 5v14" }), h("path", { d: "M5 12h14" })],
      refresh: [h("path", { d: "M21 12a9 9 0 0 0-15.2-6.5" }), h("path", { d: "M3 5v6h6" }), h("path", { d: "M3 12a9 9 0 0 0 15.2 6.5" }), h("path", { d: "M21 19v-6h-6" })],
      edit: [h("path", { d: "M12 20h9" }), h("path", { d: "M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" })],
      trash: [h("path", { d: "M3 6h18" }), h("path", { d: "M8 6V4h8v2" }), h("path", { d: "M19 6l-1 14H6L5 6" })],
      save: [h("path", { d: "M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" }), h("path", { d: "M17 21v-8H7v8" }), h("path", { d: "M7 3v5h8" })],
      close: [h("path", { d: "M18 6 6 18" }), h("path", { d: "m6 6 12 12" })],
      download: [h("path", { d: "M12 3v12" }), h("path", { d: "m7 10 5 5 5-5" }), h("path", { d: "M5 21h14" })],
      copy: [h("rect", { x: 9, y: 9, width: 13, height: 13, rx: 2 }), h("path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" })],
      check: [h("path", { d: "M20 6 9 17l-5-5" })],
      info: [h("circle", { cx: 12, cy: 12, r: 10 }), h("path", { d: "M12 16v-4" }), h("path", { d: "M12 8h.01" })],
      warning: [h("path", { d: "m21.7 18.6-8.4-14.3a1.5 1.5 0 0 0-2.6 0L2.3 18.6A1.5 1.5 0 0 0 3.6 21h16.8a1.5 1.5 0 0 0 1.3-2.4Z" }), h("path", { d: "M12 9v4" }), h("path", { d: "M12 17h.01" })],
      play: [h("polygon", { points: "6 3 20 12 6 21 6 3" })],
      pause: [h("rect", { x: 6, y: 4, width: 4, height: 16 }), h("rect", { x: 14, y: 4, width: 4, height: 16 })],
      clock: [h("circle", { cx: 12, cy: 12, r: 10 }), h("path", { d: "M12 6v6l4 2" })],
    };
    return h("svg", common, paths[name] || []);
  }

  function Layout(props) {
    return h("div", { className: "shell" }, [
      h("aside", { className: "sidebar" }, [
        h("div", { className: "brand" }, [
          h("span", { className: "brand-mark" }, "JM"),
          h("span", null, "Jimeng Admin"),
        ]),
        h("nav", { className: "nav" }, navItems.map((item) =>
          h("a", { key: item.key, className: props.active === item.key ? "active" : "", href: item.href }, [
            h("span", { className: "mono" }, item.icon),
            h("span", null, item.label),
          ])
        )),
      ]),
      h("main", { className: "main" }, [
        h("div", { className: "topbar" }, [
          h("div", { className: "title" }, [
            h("h1", null, props.title),
            props.subtitle ? h("p", null, props.subtitle) : null,
          ]),
          props.actions ? h("div", { className: "actions" }, props.actions) : null,
        ]),
        props.children,
      ]),
    ]);
  }

  function label(dictName, value) {
    const dict = dicts && dicts[dictName];
    if (!dict) return value || "-";
    return dict[String(value)] || dict[Number(value)] || "-";
  }

  function Badge({ value, dict, tone }) {
    const text = dict ? label(dict, value) : (value || "-");
    let resolvedTone = tone || "neutral";
    const numberValue = Number(value);
    if (!tone) {
      if ((dict === "openStatus" && numberValue === 1) || (dict === "taskSubmitStatus" && numberValue === 1) || (dict === "generationStatus" && numberValue === 2) || (dict === "accountType" && numberValue === 1)) resolvedTone = "good";
      if ((dict === "openStatus" && numberValue === 0) || (dict === "taskSubmitStatus" && numberValue === 2) || (dict === "generationStatus" && numberValue === 3)) resolvedTone = "bad";
      if ((dict === "taskSubmitStatus" && numberValue === 0) || (dict === "generationStatus" && numberValue === 1) || (dict === "accountType" && numberValue === 2)) resolvedTone = "warn";
    }
    return h("span", { className: "badge " + resolvedTone }, text);
  }

  function Button(props) {
    const classes = ["btn", props.variant || "", props.iconOnly ? "icon" : ""].filter(Boolean).join(" ");
    return h("button", { className: classes, onClick: props.onClick, disabled: props.disabled, title: props.title, type: props.type || "button" }, [
      props.icon ? icon(props.icon) : null,
      props.iconOnly ? null : props.children,
    ]);
  }

  function LinkButton(props) {
    const classes = ["btn", props.variant || "", props.iconOnly ? "icon" : ""].filter(Boolean).join(" ");
    return h("a", { className: classes, href: props.href, target: "_blank", rel: "noreferrer", title: props.title }, [
      props.icon ? icon(props.icon) : null,
      props.iconOnly ? null : props.children,
    ]);
  }

  function Field(props) {
    const inputProps = {
      value: props.value ?? "",
      onChange: (event) => props.onChange(event.target.value),
      placeholder: props.placeholder || "",
    };
    let control;
    if (props.type === "select") {
      control = h("select", inputProps, props.options.map((option) => {
        const value = typeof option === "object" ? option.value : option;
        const text = typeof option === "object" ? option.label : option;
        return h("option", { key: value, value }, text);
      }));
    } else if (props.type === "textarea") {
      control = h("textarea", inputProps);
    } else {
      control = h("input", { ...inputProps, type: props.type || "text" });
    }
    return h("label", { className: "field " + (props.wide ? "wide" : "") }, [
      h("span", null, props.label),
      control,
    ]);
  }

  function formatDate(value) {
    if (!value) return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString("zh-CN", { hour12: false });
  }

  function dictOptions(dictName) {
    return Object.entries(dicts[dictName]).map(([value, optionLabel]) => ({ value, label: optionLabel }));
  }

  function Empty({ loading }) {
    return h("div", { className: "empty" }, loading ? "加载中..." : "暂无数据");
  }

  function usePagination(items, defaultPageSize) {
    const [page, setPage] = React.useState(1);
    const [pageSize, setPageSize] = React.useState(defaultPageSize || 10);
    const total = items.length;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const currentPage = Math.min(page, pageCount);
    const startIndex = total ? (currentPage - 1) * pageSize : 0;
    const endIndex = Math.min(startIndex + pageSize, total);
    const pageRows = items.slice(startIndex, endIndex);

    React.useEffect(() => {
      setPage(1);
    }, [total, pageSize]);

    function PaginationBar() {
      return h("div", { className: "pagination" }, [
        h("div", { className: "pagination-info" }, total
          ? "显示 " + (startIndex + 1) + "-" + endIndex + " 条，共 " + total + " 条"
          : "暂无数据"),
        h("div", { className: "pagination-controls" }, [
          h("label", null, [
            h("span", null, "每页"),
            h("select", { value: pageSize, onChange: (event) => setPageSize(Number(event.target.value)) },
              [10, 20, 30, 50, 100].map((size) => h("option", { key: size, value: size }, size + "条"))
            ),
          ]),
          h(Button, { onClick: () => setPage(Math.max(1, currentPage - 1)), disabled: currentPage <= 1 }, "上一页"),
          h("span", { className: "page-current" }, currentPage + " / " + pageCount),
          h(Button, { onClick: () => setPage(Math.min(pageCount, currentPage + 1)), disabled: currentPage >= pageCount }, "下一页"),
        ]),
      ]);
    }

    return { pageRows, PaginationBar, pageSize, setPageSize, page: currentPage, setPage };
  }

  function usePrompts() {
    const [toasts, setToasts] = React.useState([]);
    const [confirmState, setConfirmState] = React.useState(null);

    function removeToast(id) {
      setToasts((items) => items.filter((item) => item.id !== id));
    }

    function notify(type, title, message) {
      const id = Date.now() + Math.random();
      setToasts((items) => [...items, { id, type, title, message }]);
      window.setTimeout(() => removeToast(id), type === "error" ? 5200 : 3400);
    }

    function confirm(options) {
      return new Promise((resolve) => {
        setConfirmState({
          type: options.type || "warning",
          title: options.title || "操作确认",
          message: options.message || "确认继续执行该操作？",
          confirmText: options.confirmText || "确认",
          cancelText: options.cancelText || "取消",
          resolve,
        });
      });
    }

    function closeConfirm(result) {
      if (confirmState?.resolve) confirmState.resolve(result);
      setConfirmState(null);
    }

    function PromptHost() {
      const iconNameByType = { success: "check", error: "close", warning: "warning", info: "info", danger: "warning" };
      return h(React.Fragment, null, [
        h("div", { className: "toast-stack" }, toasts.map((item) =>
          h("div", { key: item.id, className: "notice " + item.type }, [
            h("span", { className: "notice-icon" }, icon(iconNameByType[item.type] || "info")),
            h("span", { className: "notice-body" }, [
              h("strong", null, item.title),
              item.message ? h("span", null, item.message) : null,
            ]),
            h(Button, { icon: "close", iconOnly: true, title: "关闭", onClick: () => removeToast(item.id) }),
          ])
        )),
        confirmState ? h("div", { className: "modal-backdrop" }, [
          h("div", { className: "confirm-modal " + confirmState.type }, [
            h("div", { className: "confirm-icon" }, icon(iconNameByType[confirmState.type] || "warning")),
            h("div", { className: "confirm-content" }, [
              h("h2", null, confirmState.title),
              h("p", null, confirmState.message),
            ]),
            h("div", { className: "confirm-actions" }, [
              h(Button, { onClick: () => closeConfirm(false) }, confirmState.cancelText),
              h(Button, { variant: confirmState.type === "danger" ? "danger-fill" : "primary", onClick: () => closeConfirm(true) }, confirmState.confirmText),
            ]),
          ]),
        ]) : null,
      ]);
    }

    return {
      notify: {
        success: (title, message) => notify("success", title, message),
        error: (title, message) => notify("error", title, message),
        warning: (title, message) => notify("warning", title, message),
        info: (title, message) => notify("info", title, message),
      },
      confirm,
      PromptHost,
    };
  }

  window.Admin = {
    h,
    api,
    icon,
    Layout,
    Badge,
    Button,
    LinkButton,
    Field,
    Empty,
    formatDate,
    dictOptions,
    dictionaries: dicts,
    label,
    usePrompts,
    usePagination,
  };
})();
