/**
 * 游戏模块契约 (CONTRACT)
 * ---------------------------------------------------------------------------
 * 每个游戏文件 default-export 一个对象：
 * {
 *   id:   string,            // 唯一 ID（小写字母/数字）
 *   name: string,            // 显示名
 *   icon: string,            // emoji 图标
 *   tag:  string,            // 分类标签（如「三消」「解谜」）
 *   desc: string,            // 一句话简介
 *   maxLevel: number,        // 最大关卡数
 *   config(level): object,   // 返回该关卡的配置对象（难度递进在此体现）
 *   mount(root, api): void   // 渲染游戏；root 为挂载容器（已清空）
 * }
 *
 * api 对象（由 shell 注入）：
 *   level:    number         // 当前关卡
 *   cfg:      object         // config(level) 的返回值
 *   setHud(html: string)     // 设置顶栏 HUD（步数/时间/分数/目标）
 *   win(stars=1, score=0)   // 触发胜利（stars 1~3，score 为本局得分，金币由框架按 max(1,floor(score/25)) 计算）
 *   lose()                   // 触发失败
 *   toast(msg: string)       // 轻提示
 *   setClock(sec|null)       // 更新顶栏倒计时（限时关卡调用；null 清空）
 *   onDestroy(fn)            // 注册清理回调（定时器/监听，切换关卡时调用）
 *   store                   // 存档实例（见 store.js）
 *   restart()               // 重开本关
 *
 * 约定：游戏在调用 win/lose 后应立即停止自身循环（api 内部有 ended 守卫，
 *       但游戏仍应自行停止 rAF/定时器以避免后台空转）。
 */
export const CONTRACT_VERSION = 1;
