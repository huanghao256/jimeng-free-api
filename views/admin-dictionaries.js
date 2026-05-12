(function () {
  window.AdminDictionaries = {
    openStatus: {
      0: "关闭",
      1: "开启",
    },
    taskSubmitStatus: {
      0: "待处理",
      1: "成功",
      2: "失败",
    },
    generationStatus: {
      0: "",
      1: "生成中",
      2: "已生成",
      3: "生成失败",
    },
    accountType: {
      1: "收费",
      2: "免费",
    },
    regions: ["国区", "美区", "日区", "港区", "新加坡区"],
    codes: {
      open: { disabled: 0, enabled: 1 },
      taskSubmit: { pending: 0, success: 1, failed: 2 },
      generation: { none: 0, processing: 1, generated: 2, failed: 3 },
      accountType: { paid: 1, free: 2 },
    },
  };
})();
