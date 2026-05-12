(function () {
  const { h, api, Layout, Button, dictionaries, label, usePrompts } = window.Admin;
  const defaultForm = { accountType: 2, region: "国区", maxParallelTasks: 1, callbackIntervalMinutes: 1 };

  function RadioGroup({ title, value, options, onChange }) {
    return h("div", { className: "config-group" }, [
      h("h2", null, title),
      h("div", { className: "radio-grid" }, options.map((option) =>
        h("label", { key: option.value, className: "radio-card " + (String(value) === String(option.value) ? "active" : "") }, [
          h("input", { type: "radio", checked: String(value) === String(option.value), onChange: () => onChange(option.value) }),
          h("span", null, option.label),
        ])
      )),
    ]);
  }

  function App() {
    const prompts = usePrompts();
    const [form, setForm] = React.useState(defaultForm);
    const [loading, setLoading] = React.useState(true);
    const [saving, setSaving] = React.useState(false);

    async function load() {
      setLoading(true);
      try {
        const data = await api("/admin/api/system-config");
        setForm({
          accountType: data.accountType || 2,
          region: data.region || "国区",
          maxParallelTasks: data.maxParallelTasks || 1,
          callbackIntervalMinutes: data.callbackIntervalMinutes || 1,
        });
      } catch (err) {
        prompts.notify.error("加载失败", err.message);
      } finally {
        setLoading(false);
      }
    }

    React.useEffect(() => { load(); }, []);

    function setField(key, value) {
      setForm((old) => ({ ...old, [key]: value }));
    }

    async function save() {
      const maxParallelTasks = Number(form.maxParallelTasks);
      if (!Number.isInteger(maxParallelTasks) || maxParallelTasks < 1) {
        prompts.notify.warning("配置无效", "任务并行最大数必须是大于0的整数。");
        return;
      }
      const callbackIntervalMinutes = Number(form.callbackIntervalMinutes);
      if (!Number.isInteger(callbackIntervalMinutes) || callbackIntervalMinutes < 1) {
        prompts.notify.warning("配置无效", "查询间隔时间必须是大于0的整数。");
        return;
      }
      setSaving(true);
      try {
        const data = await api("/admin/api/system-config", {
          method: "PUT",
          body: { ...form, accountType: Number(form.accountType), maxParallelTasks, callbackIntervalMinutes },
        });
        setForm(data);
        prompts.notify.success("保存成功", "系统配置已更新。");
      } catch (err) {
        prompts.notify.error("保存失败", err.message);
      } finally {
        setSaving(false);
      }
    }

    return h(Layout, {
      active: "system",
      title: "系统配置管理",
      subtitle: "配置默认账号类型、任务区域和任务并行最大数。",
      actions: [
        h(Button, { icon: "refresh", onClick: load, disabled: loading }, "刷新"),
        h(Button, { icon: "save", variant: "primary", onClick: save, disabled: saving }, saving ? "保存中" : "保存"),
      ],
    }, [
      h("section", { className: "config-panel" }, [
        h(RadioGroup, {
          title: "账号类型",
          value: form.accountType,
          options: [
            { value: 2, label: label("accountType", 2) },
            { value: 1, label: label("accountType", 1) },
          ],
          onChange: (value) => setField("accountType", Number(value)),
        }),
        h(RadioGroup, {
          title: "区域",
          value: form.region,
          options: dictionaries.regions.map((region) => ({ value: region, label: region })),
          onChange: (value) => setField("region", value),
        }),
        h("div", { className: "config-group compact" }, [
          h("h2", null, "任务并行最大数"),
          h("input", {
            type: "number",
            min: 1,
            step: 1,
            value: form.maxParallelTasks,
            onChange: (event) => setField("maxParallelTasks", event.target.value),
          }),
          h("p", null, "请输入正整数，默认值为 1。"),
        ]),
        h("div", { className: "config-group compact" }, [
          h("h2", null, "查询间隔时间（分钟）"),
          h("input", {
            type: "number",
            min: 1,
            step: 1,
            value: form.callbackIntervalMinutes,
            onChange: (event) => setField("callbackIntervalMinutes", event.target.value),
          }),
          h("p", null, "任务回调会按该间隔查询已提交任务。"),
        ]),
      ]),
      h(prompts.PromptHost),
    ]);
  }

  ReactDOM.createRoot(document.getElementById("root")).render(h(App));
})();
