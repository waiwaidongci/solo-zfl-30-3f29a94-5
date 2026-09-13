/* app.js —— 启动引导：创建 store，挂载 UI。 */
(function () {
  "use strict";
  const store = Store.createStore();
  window.appStore = store; // 供浏览器检查脚本与调试使用
  UI.init(store);
})();
