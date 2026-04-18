#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
taskbar_monitor.py - 任务栏监控模块
检测任务栏中固定和运行的应用程序，监控任务栏状态变化并发送到服务器。
使用 Windows Shell API 获取任务栏应用程序列表。
"""

import logging
import threading
import time
import json
from typing import Optional, Dict, Any, List, Set, Callable

logger = logging.getLogger(__name__)

# 尝试导入 Windows API
try:
    import ctypes
    import ctypes.wintypes
    WIN32_AVAILABLE = True
except ImportError:
    WIN32_AVAILABLE = False
    logger.warning("ctypes 不可用，任务栏监控将被禁用")


class TaskbarApp:
    """任务栏应用程序信息"""

    def __init__(self, app_id: str = "", name: str = "", exe_path: str = "",
                 is_running: bool = False, is_pinned: bool = False,
                 window_handles: Optional[List[int]] = None):
        self.app_id = app_id          # 应用用户模型ID (AppUserModelID)
        self.name = name              # 应用名称
        self.exe_path = exe_path      # 可执行文件路径
        self.is_running = is_running  # 是否正在运行
        self.is_pinned = is_pinned    # 是否固定到任务栏
        self.window_handles = window_handles or []  # 关联的窗口句柄列表

    def to_dict(self) -> Dict[str, Any]:
        """转换为字典"""
        return {
            "app_id": self.app_id,
            "name": self.name,
            "exe_path": self.exe_path,
            "is_running": self.is_running,
            "is_pinned": self.is_pinned,
            "window_count": len(self.window_handles)
        }

    def __eq__(self, other):
        if isinstance(other, TaskbarApp):
            return self.app_id == other.app_id or self.exe_path == other.exe_path
        return False

    def __hash__(self):
        return hash(self.app_id or self.exe_path)

    def __repr__(self):
        return f"TaskbarApp(name='{self.name}', running={self.is_running}, pinned={self.is_pinned})"


class TaskbarMonitor:
    """任务栏监控器"""

    def __init__(self, api_client=None, check_interval: float = 30.0):
        """
        初始化任务栏监控器
        :param api_client: API 客户端实例
        :param check_interval: 检查间隔（秒）
        """
        self.api_client = api_client
        self.check_interval = check_interval

        # 当前任务栏状态
        self._current_apps: Dict[str, TaskbarApp] = {}  # app_id -> TaskbarApp
        self._last_state_hash: str = ""
        self._lock = threading.Lock()

        # 监控线程
        self._monitor_thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._running = False

        # 状态变更回调
        self._on_change_callbacks: List[Callable[[Dict[str, Any], Dict[str, Any]], None]] = []

        # 统计数据
        self._report_count = 0

        logger.info(f"任务栏监控器初始化完成 - 检查间隔: {check_interval}s")

    def on_change(self, callback: Callable[[Dict[str, Any], Dict[str, Any]], None]):
        """
        注册任务栏状态变更回调
        :param callback: 回调函数 (old_state, new_state)
        """
        self._on_change_callbacks.append(callback)

    def _notify_change(self, old_state: Dict[str, Any], new_state: Dict[str, Any]):
        """通知状态变更"""
        for cb in self._on_change_callbacks:
            try:
                cb(old_state, new_state)
            except Exception as e:
                logger.error(f"任务栏变更回调执行失败: {e}")

    def start(self):
        """启动任务栏监控"""
        if not WIN32_AVAILABLE:
            logger.error("Windows API 不可用，无法启动任务栏监控")
            return False

        if self._running:
            logger.warning("任务栏监控已在运行")
            return True

        self._stop_event.clear()
        self._running = True

        # 立即执行一次检查
        self._check_taskbar()

        # 启动监控线程
        self._monitor_thread = threading.Thread(
            target=self._monitor_loop,
            name="TaskbarMonitor",
            daemon=True
        )
        self._monitor_thread.start()
        logger.info("任务栏监控已启动")
        return True

    def stop(self):
        """停止任务栏监控"""
        self._stop_event.set()
        self._running = False

        if self._monitor_thread and self._monitor_thread.is_alive():
            self._monitor_thread.join(timeout=10)

        logger.info("任务栏监控已停止")

    def _monitor_loop(self):
        """任务栏监控主循环"""
        logger.info("任务栏监控线程已启动")

        while not self._stop_event.is_set():
            try:
                self._check_taskbar()
            except Exception as e:
                logger.error(f"任务栏检查出错: {e}")

            self._stop_event.wait(self.check_interval)

        logger.info("任务栏监控线程已退出")

    def _check_taskbar(self):
        """检查任务栏状态并报告变化"""
        try:
            # 获取当前任务栏应用列表
            apps = self._get_taskbar_apps()
            new_apps = {self._app_key(app): app for app in apps}

            # 计算状态哈希，检测变化
            new_state = json.dumps(
                {k: v.to_dict() for k, v in new_apps.items()},
                sort_keys=True, ensure_ascii=False
            )

            with self._lock:
                old_state = json.dumps(
                    {k: v.to_dict() for k, v in self._current_apps.items()},
                    sort_keys=True, ensure_ascii=False
                )

            if new_state != old_state:
                # 状态发生了变化
                with self._lock:
                    old_apps_dict = {
                        k: v.to_dict() for k, v in self._current_apps.items()
                    }
                    self._current_apps = new_apps

                new_apps_dict = {k: v.to_dict() for k, v in new_apps.items()}

                # 检测具体变化
                changes = self._detect_changes(old_apps_dict, new_apps_dict)
                logger.info(f"任务栏状态变化: {changes}")

                # 通知回调
                self._notify_change(old_apps_dict, new_apps_dict)

                # 发送到服务器
                self._report_to_server(new_apps_dict, changes)

            self._last_state_hash = new_state

        except Exception as e:
            logger.error(f"任务栏状态检查失败: {e}")

    def _app_key(self, app: TaskbarApp) -> str:
        """生成应用的唯一标识键"""
        return app.app_id or app.exe_path or app.name

    def _get_taskbar_apps(self) -> List[TaskbarApp]:
        """
        获取当前任务栏上的应用程序列表
        通过枚举所有可见窗口来推断任务栏应用
        :return: TaskbarApp 列表
        """
        apps = {}
        seen_pids = set()

        try:
            user32 = ctypes.windll.user32
            WNDENUMPROC = ctypes.WINFUNCTYPE(
                ctypes.wintypes.BOOL,
                ctypes.wintypes.HWND,
                ctypes.wintypes.LPARAM
            )

            def enum_callback(hwnd, lparam):
                """窗口枚举回调"""
                try:
                    # 只处理可见窗口
                    if not user32.IsWindowVisible(hwnd):
                        return True

                    # 获取窗口标题
                    length = user32.GetWindowTextLengthW(hwnd)
                    if length == 0:
                        return True

                    buf = ctypes.create_unicode_buffer(length + 1)
                    user32.GetWindowTextW(hwnd, buf, length + 1)
                    title = buf.value.strip()

                    if not title:
                        return True

                    # 过滤系统窗口
                    class_buf = ctypes.create_unicode_buffer(256)
                    user32.GetClassNameW(hwnd, class_buf, 256)
                    class_name = class_buf.value

                    # 跳过系统窗口和不可见的应用
                    skip_classes = {
                        'IME', 'MSCTFIME UI', 'Windows.UI.Core.CoreWindow',
                        'Shell_TrayWnd', 'Shell_SecondaryTrayWnd',
                        'NotifyIconOverflowWindow', 'TaskListOverlayWnd'
                    }
                    if class_name in skip_classes:
                        return True

                    # 获取进程信息
                    process_id = ctypes.wintypes.DWORD()
                    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(process_id))
                    pid = process_id.value

                    # 获取窗口样式
                    ex_style = user32.GetWindowLongW(hwnd, -20)  # GWL_EXSTYLE
                    is_tool_window = bool(ex_style & 0x00000080)  # WS_EX_TOOLWINDOW
                    is_app_window = bool(ex_style & 0x00040000)  # WS_EX_APPWINDOW

                    # 工具窗口通常不显示在任务栏（除非同时是 APPWINDOW）
                    if is_tool_window and not is_app_window:
                        return True

                    # 获取进程名称和路径
                    process_name, exe_path = self._get_process_info(pid)

                    if not process_name:
                        return True

                    # 过滤系统进程
                    skip_processes = {
                        'explorer.exe', 'SearchUI.exe', 'ShellExperienceHost.exe',
                        'Taskmgr.exe', 'ApplicationFrameHost.exe'
                    }
                    if process_name.lower() in skip_processes:
                        return True

                    # 创建或更新应用信息
                    key = exe_path or process_name
                    if key not in apps:
                        apps[key] = TaskbarApp(
                            app_id=key,
                            name=process_name.replace('.exe', ''),
                            exe_path=exe_path,
                            is_running=True,
                            is_pinned=False
                        )
                    apps[key].window_handles.append(hwnd)
                    seen_pids.add(pid)

                except Exception as e:
                    logger.debug(f"窗口枚举处理出错: {e}")

                return True

            # 枚举所有窗口
            callback = WNDENUMPROC(enum_callback)
            user32.EnumWindows(callback, 0)

        except Exception as e:
            logger.error(f"枚举窗口失败: {e}")

        # 获取固定应用列表（从快捷方式）
        pinned_apps = self._get_pinned_apps()
        for pinned in pinned_apps:
            key = pinned.exe_path or pinned.name
            if key in apps:
                apps[key].is_pinned = True
            else:
                # 固定但未运行的应用
                apps[key] = pinned

        return list(apps.values())

    def _get_process_info(self, pid: int) -> tuple:
        """获取进程名称和路径"""
        try:
            kernel32 = ctypes.windll.kernel32
            psapi = ctypes.windll.psapi

            PROCESS_QUERY_INFORMATION = 0x0400
            PROCESS_VM_READ = 0x0010
            hProcess = kernel32.OpenProcess(
                PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid
            )

            if hProcess:
                try:
                    buf = ctypes.create_unicode_buffer(1024)
                    result = psapi.GetModuleFileNameExW(hProcess, None, buf, 1024)
                    if result > 0:
                        exe_path = buf.value
                        process_name = exe_path.split('\\')[-1]
                        return process_name, exe_path
                except Exception:
                    pass
                finally:
                    kernel32.CloseHandle(hProcess)
        except Exception:
            pass

        return "", ""

    def _get_pinned_apps(self) -> List[TaskbarApp]:
        """
        获取固定到任务栏的应用列表
        通过读取任务栏快捷方式目录
        :return: 固定应用列表
        """
        pinned = []
        try:
            import os
            import winreg

            # 方法1: 通过注册表获取任务栏固定应用
            # 快速启动路径
            quick_launch = os.path.join(
                os.environ.get('APPDATA', ''),
                r'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'
            )

            if os.path.exists(quick_launch):
                for filename in os.listdir(quick_launch):
                    if filename.endswith('.lnk'):
                        filepath = os.path.join(quick_launch, filename)
                        try:
                            # 使用 COM 读取快捷方式目标
                            name = filename.replace('.lnk', '')
                            pinned.append(TaskbarApp(
                                app_id=filepath,
                                name=name,
                                exe_path=filepath,
                                is_running=False,
                                is_pinned=True
                            ))
                        except Exception as e:
                            logger.debug(f"读取快捷方式失败 {filename}: {e}")

        except Exception as e:
            logger.debug(f"获取固定应用失败: {e}")

        return pinned

    def _detect_changes(self, old_state: Dict[str, Any],
                        new_state: Dict[str, Any]) -> Dict[str, Any]:
        """
        检测任务栏状态变化
        :param old_state: 旧状态字典
        :param new_state: 新状态字典
        :return: 变化描述
        """
        old_keys = set(old_state.keys())
        new_keys = set(new_state.keys())

        added = new_keys - old_keys
        removed = old_keys - new_keys
        common = old_keys & new_keys

        running_changed = []
        for key in common:
            old_app = old_state[key]
            new_app = new_state[key]
            if old_app.get('is_running') != new_app.get('is_running'):
                running_changed.append({
                    "app": key,
                    "was_running": old_app.get('is_running'),
                    "now_running": new_app.get('is_running')
                })

        return {
            "added": list(added),
            "removed": list(removed),
            "running_changed": running_changed,
            "total_running": sum(1 for v in new_state.values() if v.get('is_running')),
            "total_pinned": sum(1 for v in new_state.values() if v.get('is_pinned'))
        }

    def _report_to_server(self, apps_dict: Dict[str, Any], changes: Dict[str, Any]):
        """向服务器报告任务栏状态"""
        if not self.api_client:
            return

        data = {
            "apps": apps_dict,
            "changes": changes,
            "total_apps": len(apps_dict),
            "running_apps": sum(1 for v in apps_dict.values() if v.get('is_running')),
            "pinned_apps": sum(1 for v in apps_dict.values() if v.get('is_pinned'))
        }

        try:
            self.api_client.send_taskbar_state(data)
            self._report_count += 1
            logger.debug(f"任务栏状态已报告 - 共 {len(apps_dict)} 个应用")
        except Exception as e:
            logger.error(f"发送任务栏状态失败: {e}")

    def get_current_state(self) -> Dict[str, Any]:
        """获取当前任务栏状态"""
        with self._lock:
            return {k: v.to_dict() for k, v in self._current_apps.items()}

    def get_statistics(self) -> Dict[str, Any]:
        """获取监控统计"""
        with self._lock:
            apps = self._current_apps
            return {
                "report_count": self._report_count,
                "total_apps": len(apps),
                "running_apps": sum(1 for v in apps.values() if v.is_running),
                "pinned_apps": sum(1 for v in apps.values() if v.is_pinned)
            }

    def shutdown(self):
        """关闭任务栏监控器"""
        self.stop()
        logger.info("任务栏监控器已关闭")
