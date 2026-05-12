(function () {
  const { h, api, Layout, Badge, Button, Field, Empty, formatDate, dictOptions, label, usePrompts, usePagination } = window.Admin;
  const blank = { account: "", password: "", host: "", port: "", status: 1 };
  const batchExample = "149.115.105.87:3000:pcp2xwl51:fozvuMDzi\n149.115.105.19:3000:ublcdav4d:heGmJ9mIa";

  function App() {
    const prompts = usePrompts();
    const [rows, setRows] = React.useState([]);
    const [form, setForm] = React.useState(blank);
    const [editingId, setEditingId] = React.useState(null);
    const [showForm, setShowForm] = React.useState(false);
    const [showBatch, setShowBatch] = React.useState(false);
    const [batchText, setBatchText] = React.useState("");
    const [loading, setLoading] = React.useState(true);
    const [keyword, setKeyword] = React.useState("");
    const [selectedIds, setSelectedIds] = React.useState([]);

    async function load(showNotice) {
      setLoading(true);
      try {
        setRows(await api("/admin/api/socks5"));
        setSelectedIds([]);
        if (showNotice) prompts.notify.success("刷新完成", "Socket5列表已更新。");
      } catch (err) {
        prompts.notify.error("加载失败", err.message);
      } finally {
        setLoading(false);
      }
    }

    React.useEffect(() => { load(false); }, []);

    function setField(key, value) {
      setForm((old) => ({ ...old, [key]: value }));
    }

    function startCreate() {
      setEditingId(null);
      setForm(blank);
      setShowForm(true);
      setShowBatch(false);
      prompts.notify.info("新增模式", "填写代理账号后保存即可生效。");
    }

    function startBatch() {
      setShowBatch(true);
      setShowForm(false);
      if (!batchText) setBatchText(batchExample);
    }

    function startEdit(row) {
      setEditingId(row.id);
      setForm({ account: row.account, password: row.password, host: row.host, port: row.port, status: row.status });
      setShowForm(true);
      setShowBatch(false);
    }

    async function save() {
      try {
        const payload = { ...form, port: Number(form.port) || 0, status: Number(form.status) };
        if (editingId) await api("/admin/api/socks5/" + editingId, { method: "PUT", body: payload });
        else await api("/admin/api/socks5", { method: "POST", body: payload });
        setShowForm(false);
        prompts.notify.success("保存成功", editingId ? "Socket5账号已更新。" : "Socket5账号已创建。");
        await load(false);
      } catch (err) {
        prompts.notify.error("保存失败", err.message);
      }
    }

    async function saveBatch() {
      try {
        const result = await api("/admin/api/socks5/batch", { method: "POST", body: { text: batchText } });
        setShowBatch(false);
        setBatchText("");
        prompts.notify.success("批量添加完成", "已添加 " + result.count + " 个Socket5账号。");
        await load(false);
      } catch (err) {
        prompts.notify.error("批量添加失败", err.message);
      }
    }

    async function remove(id) {
      const ok = await prompts.confirm({
        type: "danger",
        title: "删除Socket5账号",
        message: "删除后该代理配置将从后台移除，确认继续吗？",
        confirmText: "删除",
      });
      if (!ok) return;
      try {
        await api("/admin/api/socks5/" + id, { method: "DELETE" });
        prompts.notify.success("删除成功", "Socket5账号已移除。");
        await load(false);
      } catch (err) {
        prompts.notify.error("删除失败", err.message);
      }
    }

    function toggleSelected(id) {
      setSelectedIds((ids) => ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]);
    }

    function setAllSelected(checked, ids) {
      setSelectedIds(checked ? ids : []);
    }

    async function batchDelete() {
      if (!selectedIds.length) return prompts.notify.warning("未选择账号", "请先勾选要删除的Socket5账号。");
      const ok = await prompts.confirm({
        type: "danger",
        title: "批量删除Socket5账号",
        message: "将删除已勾选的 " + selectedIds.length + " 个Socket5账号，确认继续吗？",
        confirmText: "批量删除",
      });
      if (!ok) return;
      try {
        const result = await api("/admin/api/socks5/batch-delete", { method: "POST", body: { ids: selectedIds } });
        prompts.notify.success("批量删除完成", "已删除 " + result.count + " 个Socket5账号。");
        await load(false);
      } catch (err) {
        prompts.notify.error("批量删除失败", err.message);
      }
    }

    async function batchStatus(status) {
      if (!selectedIds.length) return prompts.notify.warning("未选择账号", "请先勾选要操作的Socket5账号。");
      const text = Number(status) === 1 ? "开启" : "关闭";
      const ok = await prompts.confirm({
        type: "warning",
        title: "批量" + text + "Socket5账号",
        message: "将" + text + "已勾选的 " + selectedIds.length + " 个Socket5账号，确认继续吗？",
        confirmText: text,
      });
      if (!ok) return;
      try {
        const result = await api("/admin/api/socks5/batch-status", { method: "POST", body: { ids: selectedIds, status } });
        prompts.notify.success("批量操作完成", "已" + text + " " + result.count + " 个Socket5账号。");
        await load(false);
      } catch (err) {
        prompts.notify.error("批量操作失败", err.message);
      }
    }

    const filtered = rows.filter((row) => {
      const haystack = [row.account, row.host, label("openStatus", row.status), row.port].join(" ").toLowerCase();
      return haystack.includes(keyword.toLowerCase());
    });
    const pagination = usePagination(filtered, 10);
    const pageRows = pagination.pageRows;
    const pageIds = pageRows.map((row) => row.id);
    const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.includes(id));

    const formView = showForm ? h("div", { className: "form-grid" }, [
      h(Field, { label: "账号", value: form.account, onChange: (v) => setField("account", v) }),
      h(Field, { label: "密码", value: form.password, onChange: (v) => setField("password", v), type: "password" }),
      h(Field, { label: "IP", value: form.host, onChange: (v) => setField("host", v), placeholder: "127.0.0.1" }),
      h(Field, { label: "端口", value: form.port, onChange: (v) => setField("port", v), type: "number" }),
      h(Field, { label: "状态", value: form.status, onChange: (v) => setField("status", v), type: "select", options: dictOptions("openStatus") }),
      h("div", { className: "field" }, [
        h("span", null, " "),
        h("div", { className: "actions" }, [
          h(Button, { icon: "save", variant: "primary", onClick: save }, "保存"),
          h(Button, { icon: "close", onClick: () => setShowForm(false) }, "取消"),
        ]),
      ]),
    ]) : null;

    const batchView = showBatch ? h("div", { className: "batch-panel" }, [
      h("div", { className: "batch-head" }, [
        h("strong", null, "批量添加Socket5账号"),
        h("span", null, "每行一个账号，格式：hostname:port:username:password"),
      ]),
      h("textarea", {
        value: batchText,
        onChange: (event) => setBatchText(event.target.value),
        placeholder: batchExample,
      }),
      h("div", { className: "batch-actions" }, [
        h(Button, { icon: "save", variant: "primary", onClick: saveBatch }, "导入账号"),
        h(Button, { icon: "close", onClick: () => setShowBatch(false) }, "取消"),
      ]),
    ]) : null;

    const selectionBar = selectedIds.length ? h("div", { className: "selection-bar" }, [
      h("strong", null, "已选择 " + selectedIds.length + " 个账号"),
      h("div", { className: "actions" }, [
        h(Button, { onClick: () => batchStatus(1) }, "批量开启"),
        h(Button, { onClick: () => batchStatus(0) }, "批量关闭"),
        h(Button, { icon: "trash", variant: "danger", onClick: batchDelete }, "批量删除"),
      ]),
    ]) : null;

    return h(Layout, {
      active: "socks5",
      title: "Socket5管理",
      subtitle: "维护可用代理账号、连接地址与启停状态。",
      actions: [
        h(Button, { icon: "refresh", onClick: () => load(true), disabled: loading }, "刷新"),
        h(Button, { icon: "plus", onClick: startBatch }, "批量添加"),
        h(Button, { icon: "plus", variant: "primary", onClick: startCreate }, "新增"),
      ],
    }, [
      h("section", { className: "panel" }, [
        h("div", { className: "toolbar" }, [
          h("input", { className: "search", value: keyword, onChange: (e) => setKeyword(e.target.value), placeholder: "搜索账号、IP或状态" }),
          h("span", { className: "muted" }, "共 " + filtered.length + " 条"),
        ]),
        selectionBar,
        formView,
        batchView,
        pageRows.length ? h("div", { className: "table-wrap" }, h("table", { className: "socks5-table" }, [
          h("thead", null, h("tr", null, [
            h("th", { key: "select" }, h("input", { type: "checkbox", checked: allPageSelected, onChange: (e) => setAllSelected(e.target.checked, pageIds) })),
            ...["账号", "密码", "IP:端口", "状态", "创建时间", "操作"].map((text) => h("th", { key: text }, text)),
          ])),
          h("tbody", null, pageRows.map((row) => h("tr", { key: row.id, className: selectedIds.includes(row.id) ? "selected-row" : "" }, [
            h("td", null, h("input", { type: "checkbox", checked: selectedIds.includes(row.id), onChange: () => toggleSelected(row.id) })),
            h("td", { className: "truncate" }, row.account),
            h("td", { className: "mono truncate" }, row.password ? "••••••••" : "-"),
            h("td", { className: "mono" }, row.host + ":" + row.port),
            h("td", null, h(Badge, { value: row.status, dict: "openStatus" })),
            h("td", null, formatDate(row.createdAt)),
            h("td", null, h("div", { className: "row-actions" }, [
              h(Button, { icon: "edit", iconOnly: true, title: "编辑", onClick: () => startEdit(row) }),
              h(Button, { icon: "trash", iconOnly: true, variant: "danger", title: "删除", onClick: () => remove(row.id) }),
            ])),
          ]))),
        ])) : h(Empty, { loading }),
        h(pagination.PaginationBar),
      ]),
      h(prompts.PromptHost),
    ]);
  }

  ReactDOM.createRoot(document.getElementById("root")).render(h(App));
})();
