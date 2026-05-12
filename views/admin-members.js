(function () {
  const { h, api, Layout, Badge, Button, Field, Empty, formatDate, dictOptions, dictionaries, label, usePrompts, usePagination } = window.Admin;
  const blank = {
    accountName: "",
    sessionId: "",
    dailyTaskLimit: 100,
    region: "国区",
    status: 1,
    accountType: 2,
    credits: 0,
  };

  function App() {
    const prompts = usePrompts();
    const fileRef = React.useRef(null);
    const [rows, setRows] = React.useState([]);
    const [form, setForm] = React.useState(blank);
    const [editingId, setEditingId] = React.useState(null);
    const [showForm, setShowForm] = React.useState(false);
    const [loading, setLoading] = React.useState(true);
    const [keyword, setKeyword] = React.useState("");
    const [selectedIds, setSelectedIds] = React.useState([]);

    async function load(showNotice) {
      setLoading(true);
      try {
        setRows(await api("/admin/api/members"));
        setSelectedIds([]);
        if (showNotice) prompts.notify.success("刷新完成", "会员账号列表已更新。");
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
      prompts.notify.info("新增模式", "填写账号信息后保存即可加入会员池。");
    }

    function startEdit(row) {
      setEditingId(row.id);
      setForm({
        accountName: row.accountName,
        sessionId: row.sessionId,
        dailyTaskLimit: row.dailyTaskLimit,
        region: row.region,
        status: row.status,
        accountType: row.accountType,
        credits: row.credits,
      });
      setShowForm(true);
    }

    async function save() {
      try {
        const payload = {
          ...form,
          dailyTaskLimit: Number(form.dailyTaskLimit) || 0,
          credits: Number(form.credits) || 0,
          status: Number(form.status),
          accountType: Number(form.accountType),
        };
        if (editingId) await api("/admin/api/members/" + editingId, { method: "PUT", body: payload });
        else await api("/admin/api/members", { method: "POST", body: payload });
        setShowForm(false);
        prompts.notify.success("保存成功", editingId ? "会员账号已更新。" : "会员账号已创建。");
        await load(false);
      } catch (err) {
        prompts.notify.error("保存失败", err.message);
      }
    }

    async function remove(id) {
      const ok = await prompts.confirm({
        type: "danger",
        title: "删除会员账号",
        message: "删除后该账号配置将无法继续用于匹配任务记录，确认继续吗？",
        confirmText: "删除",
      });
      if (!ok) return;
      try {
        await api("/admin/api/members/" + id, { method: "DELETE" });
        prompts.notify.success("删除成功", "会员账号已移除。");
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
      if (!selectedIds.length) return prompts.notify.warning("未选择账号", "请先勾选要删除的会员账号。");
      const ok = await prompts.confirm({
        type: "danger",
        title: "批量删除会员账号",
        message: "将删除已勾选的 " + selectedIds.length + " 个会员账号，确认继续吗？",
        confirmText: "批量删除",
      });
      if (!ok) return;
      try {
        const result = await api("/admin/api/members/batch-delete", { method: "POST", body: { ids: selectedIds } });
        prompts.notify.success("批量删除完成", "已删除 " + result.count + " 个会员账号。");
        await load(false);
      } catch (err) {
        prompts.notify.error("批量删除失败", err.message);
      }
    }

    async function batchStatus(status) {
      if (!selectedIds.length) return prompts.notify.warning("未选择账号", "请先勾选要操作的会员账号。");
      const text = Number(status) === 1 ? "开启" : "关闭";
      const ok = await prompts.confirm({
        type: "warning",
        title: "批量" + text + "会员账号",
        message: "将" + text + "已勾选的 " + selectedIds.length + " 个会员账号，确认继续吗？",
        confirmText: text,
      });
      if (!ok) return;
      try {
        const result = await api("/admin/api/members/batch-status", { method: "POST", body: { ids: selectedIds, status } });
        prompts.notify.success("批量操作完成", "已" + text + " " + result.count + " 个会员账号。");
        await load(false);
      } catch (err) {
        prompts.notify.error("批量操作失败", err.message);
      }
    }

    function triggerImport() {
      fileRef.current?.click();
    }

    async function importExcel(event) {
      const file = event.target.files && event.target.files[0];
      event.target.value = "";
      if (!file) return;
      if (!window.XLSX) {
        prompts.notify.error("导入失败", "Excel解析库未加载，请检查网络后刷新页面。");
        return;
      }
      try {
        const buffer = await file.arrayBuffer();
        const workbook = XLSX.read(buffer, { type: "array" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" }).map((row) => ({
          accountName: row["账号名称"] || row.accountName || row["账号名"] || "",
          sessionId: row.sessionId || row.sessionID || row["sessionId"] || row["sessionID"] || "",
          accountType: row["是否收费"] || row.accountType || "免费",
        })).filter((row) => row.accountName && row.sessionId);

        if (!rows.length) {
          prompts.notify.warning("未读取到账号", "请确认Excel表头为：账号名称、sessionId、是否收费。");
          return;
        }

        const ok = await prompts.confirm({
          type: "warning",
          title: "导入会员账号",
          message: "已从Excel读取 " + rows.length + " 条账号记录，确认导入数据库吗？",
          confirmText: "导入",
        });
        if (!ok) return;

        const result = await api("/admin/api/members/import", { method: "POST", body: { rows } });
        prompts.notify.success("导入完成", "已导入 " + result.count + " 个会员账号。");
        await load(false);
      } catch (err) {
        prompts.notify.error("导入失败", err.message);
      }
    }

    const filtered = rows.filter((row) => {
      const haystack = [row.accountName, row.sessionId, row.region, row.closeReason, label("openStatus", row.status), label("accountType", row.accountType)].join(" ").toLowerCase();
      return haystack.includes(keyword.toLowerCase());
    });
    const filteredIds = filtered.map((row) => row.id);
    const pagination = usePagination(filtered, 10);
    const pageRows = pagination.pageRows;
    const pageIds = pageRows.map((row) => row.id);
    const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.includes(id));

    const formView = showForm ? h("div", { className: "form-grid members" }, [
      h(Field, { label: "账号名称", value: form.accountName, onChange: (v) => setField("accountName", v) }),
      h(Field, { label: "sessionID", value: form.sessionId, onChange: (v) => setField("sessionId", v), wide: true }),
      h(Field, { label: "每天最大任务数", value: form.dailyTaskLimit, onChange: (v) => setField("dailyTaskLimit", v), type: "number" }),
      h(Field, { label: "账号积分", value: form.credits, onChange: (v) => setField("credits", v), type: "number" }),
      h(Field, { label: "账号区域", value: form.region, onChange: (v) => setField("region", v), type: "select", options: dictionaries.regions }),
      h(Field, { label: "账号状态", value: form.status, onChange: (v) => setField("status", v), type: "select", options: dictOptions("openStatus") }),
      h(Field, { label: "账号类型", value: form.accountType, onChange: (v) => setField("accountType", v), type: "select", options: dictOptions("accountType") }),
      h("div", { className: "field" }, [
        h("span", null, " "),
        h("div", { className: "actions" }, [
          h(Button, { icon: "save", variant: "primary", onClick: save }, "保存"),
          h(Button, { icon: "close", onClick: () => setShowForm(false) }, "取消"),
        ]),
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
      active: "members",
      title: "会员账号管理",
      subtitle: "维护sessionID、区域、额度、启停状态与积分。",
      actions: [
        h(Button, { icon: "refresh", onClick: () => load(true), disabled: loading }, "刷新"),
        h(Button, { icon: "download", onClick: triggerImport }, "导入EXCEL"),
        h(Button, { icon: "plus", variant: "primary", onClick: startCreate }, "新增"),
      ],
    }, [
      h("input", { ref: fileRef, type: "file", accept: ".xlsx,.xls,.csv", className: "hidden-file", onChange: importExcel }),
      h("section", { className: "panel" }, [
        h("div", { className: "toolbar" }, [
          h("input", { className: "search", value: keyword, onChange: (e) => setKeyword(e.target.value), placeholder: "搜索账号、sessionID或区域" }),
          h("span", { className: "muted" }, "共 " + filtered.length + " 条"),
        ]),
        selectionBar,
        formView,
        pageRows.length ? h("div", { className: "table-wrap" }, h("table", { className: "members-table" }, [
          h("thead", null, h("tr", null, [
            h("th", { key: "select" }, h("input", { type: "checkbox", checked: allPageSelected, onChange: (e) => setAllSelected(e.target.checked, pageIds) })),
            ...["账号名称", "账号sessionID", "当天任务数量", "每天最大任务数", "账号区域", "账号状态", "关闭原因", "账号类型", "账号积分", "创建时间", "操作"].map((text) => h("th", { key: text }, text)),
          ])),
          h("tbody", null, pageRows.map((row) => h("tr", { key: row.id, className: selectedIds.includes(row.id) ? "selected-row" : "" }, [
            h("td", null, h("input", { type: "checkbox", checked: selectedIds.includes(row.id), onChange: () => toggleSelected(row.id) })),
            h("td", { className: "truncate" }, row.accountName),
            h("td", { className: "mono truncate" }, row.sessionId),
            h("td", null, row.todayTaskCount),
            h("td", null, row.dailyTaskLimit),
            h("td", null, row.region),
            h("td", null, h(Badge, { value: row.status, dict: "openStatus" })),
            h("td", { className: "truncate", title: row.closeReason || "" }, row.closeReason || "-"),
            h("td", null, h(Badge, { value: row.accountType, dict: "accountType" })),
            h("td", null, row.credits),
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
