// 示例插件：报时间
// 这个文件在桌宠页面里执行，通过 window.petPlugins 注册自己的动作。
window.petPlugins.register('clock', {
  action(actionId) {
    if (actionId === 'time') {
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      window.petPlugins.bubble('现在 ' + hh + ':' + mm + ' 啦~', 4);
      window.petPlugins.gesture('happy');
      return true;
    }
    return false;
  },
});