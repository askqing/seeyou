#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
window_monitor.py - 窗口监控模块
使用 ctypes + win32gui 检测当前前台窗口，实时监控窗口切换事件。
记录窗口标题、类名、进程名、可执行路径，并追踪窗口焦点持续时间。
"""

import ctypes
import ctypes.wintypes
import logging
import threading
import time
from typing import Optional, Dict, Any, List, Callable

logger = logging.getLogger(__name__)

# Windows API 常量
GWL_EXSTYLE = -20
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_APPWINDOW = 0x00040000

# Win32 API 类型定义
WNDENUMPROC = ctypes.WINFUNCTYPE(
    ctypes.wintypes.BOOL,
    ctypes.wintypes.HWND,
    ctypes.wintypes.LPARAM
)

# 定义部分 win32 结构体
class PROCESSENTRY32W(ctypes.Structure):
    """进程条目结构体"""
    _fields_ = [
        ('dwSize', ctypes.wintypes.DWORD),
        ('cntUsage', ctypes.wintypes.DWORD),
        ('th32ProcessID', ctypes.wintypes.DWORD),
        ('th32DefaultHeapID', ctypes.POINTER(ctypes.wintypes.ULONG)),
        ('th32ModuleID', ctypes.wintypes.DWORD),
        ('cntThreads', ctypes.wintypes.DWORD),
        ('th32ParentProcessID', ctypes.wintypes.DWORD),
        ('pcPriClassBase', ctypes.c_long),
        ('dwFlags', ctypes.wintypes.DWORD),
        ('szExeFile', ctypes.c_wchar * 260),
    ]


class WindowInfo:
    """窗口信息数据类"""

    def __init__(self, hwnd: int, title: str = "", class_name: str = "",
                 process_name: str = "", exe_path: str = "",
                 process_id: int = 0, is_visible: bool = True):
        self.hwnd = hwnd
        self.title = title
        self.class_name = class_name
        self.process_name = process_name
        self.exe_path = exe_path
        self.process_id = process_id
        self.is_visible = is_visible
        self.timestamp = time.time()

    def to_dict(self) -> Dict[str, Any]:
        """转换为字典"""
        return {
            "hwnd": self.hwnd,
            "title": self.title,
            "class_name": self.class_name,
            "process_name": self.process_name,
            "exe_path": self.exe_path,
            "process_id": self.process_id,
            "is_visible": self.is_visible,
            "timestamp": self.timestamp
        }

    def __repr__(self):
        return (f"WindowInfo(title='{self.title}', process='{self.process_name}', "
                f"class='{self.class_name}', pid={self.process_id})")


class WindowMonitor:
    """窗口监控器 - 实时检测前台窗口变化"""

    def __init__(self, api_client=None, poll_interval: float = 0.5,
                 min_focus_duration: float = 1.0):
        """
        初始化窗口监控器
        :param api_client: API 客户端实例
        :param poll_interval: 轮询间隔（秒）
        :param min_focus_duration: 最小焦点持续时间（秒），低于此值不记录
        """
        self.api_client = api_client
        self.poll_interval = poll_interval
        self.min_focus_duration = min_focus_duration

        # 当前窗口信息
        self._current_window: Optional[WindowInfo] = None
        self._last_hwnd = 0
        self._focus_start_time: Optional[float] = None
        self._lock = threading.Lock()

        # 监控线程
        self._monitor_thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._running = False

        # 窗口切换回调
        self._on_window_change_callbacks: List[Callable[[WindowInfo, Optional[WindowInfo], float], None]] = []

        # 统计数据
        self._switch_count = 0
        self._total_tracked_time = 0.0

        # Windows API
        self._user32 = ctypes.windll.user32
        self._kernel32 = ctypes.windll.kernel32
        self._psapi = ctypes.windll.psapi

        logger.info(f"窗口监控器初始化完成 - 轮询间隔: {poll_interval}s")

    def on_window_change(self, callback: Callable[[WindowInfo, Optional[WindowInfo], float], None]):
        """
        注册窗口切换回调
        :param callback: 回调函数 (new_window, old_window, focus_duration)
        """
        self._on_window_change_callbacks.append(callback)

    def _notify_window_change(self, new_window: WindowInfo,
                              old_window: Optional[WindowInfo], duration: float):
        """通知窗口切换"""
        for cb in self._on_window_change_callbacks:
            try:
                cb(new_window, old_window, duration)
            except Exception as e:
                logger.error(f"窗口切换回调执行失败: {e}")

    def start(self):
        """启动窗口监控"""
        if self._running:
            logger.warning("窗口监控已在运行")
            return True

        self._stop_event.clear()
        self._running = True

        # 获取初始窗口
        initial_window = self.get_foreground_window()
        with self._lock:
            self._current_window = initial_window
            self._last_hwnd = initial_window.hwnd if initial_window else 0
            self._focus_start_time = time.time()

        # 启动监控线程
        self._monitor_thread = threading.Thread(
            target=self._monitor_loop,
            name="WindowMonitor",
            daemon=True
        )
        self._monitor_thread.start()
        logger.info("窗口监控已启动")
        return True

    def stop(self):
        """停止窗口监控"""
        self._stop_event.set()
        self._running = False

        if self._monitor_thread and self._monitor_thread.is_alive():
            self._monitor_thread.join(timeout=10)

        logger.info("窗口监控已停止")

    def _monitor_loop(self):
        """窗口监控主循环"""
        logger.info("窗口监控线程已启动")

        while not self._stop_event.is_set():
            try:
                current = self.get_foreground_window()

                with self._lock:
                    last_hwnd = self._last_hwnd
                    focus_start = self._focus_start_time
                    old_window = self._current_window

                # 检测窗口变化
                current_hwnd = current.hwnd if current else 0
                if current_hwnd != last_hwnd and current is not None:
                    now = time.time()

                    # 计算上一个窗口的焦点持续时间
                    focus_duration = 0.0
                    if focus_start is not None:
                        focus_duration = now - focus_start

                    # 只记录有意义的窗口切换（标题不为空）
                    if current.title.strip():
                        # 更新状态
                        with self._lock:
                            self._current_window = current
                            self._last_hwnd = current_hwnd
                            self._focus_start_time = now
                            self._switch_count += 1
                            self._total_tracked_time += focus_duration

                        logger.info(
                            f"窗口切换: [{old_window.title if old_window else 'None'}] -> "
                            f"[{current.title}] (焦点持续: {focus_duration:.1f}s)"
                        )

                        # 通知回调
                        self._notify_window_change(current, old_window, focus_duration)

                        # 发送到服务器
                        self._report_window_change(current, old_window, focus_duration)

            except Exception as e:
                logger.error(f"窗口监控出错: {e}")

            self._stop_event.wait(self.poll_interval)

        # 停止时报告最后一个窗口的持续时间
        with self._lock:
            if self._focus_start_time and self._current_window:
                final_duration = time.time() - self._focus_start_time
                if final_duration >= self.min_focus_duration:
                    logger.info(f"最终窗口 [{self._current_window.title}] 焦点持续: {final_duration:.1f}s")

        logger.info("窗口监控线程已退出")

    def _report_window_change(self, new_window: WindowInfo,
                               old_window: Optional[WindowInfo], duration: float):
        """向服务器报告窗口切换"""
        if not self.api_client:
            return

        # 过滤掉持续时间过短的窗口切换（快速闪过的不需要报告）
        if duration < self.min_focus_duration and old_window is not None:
            return

        event_data = {
            "event_type": "window_switch",
            "new_window": new_window.to_dict(),
            "old_window": old_window.to_dict() if old_window else None,
            "focus_duration_seconds": round(duration, 2),
            "switch_count": self._switch_count
        }

        try:
            self.api_client.send_window_event(event_data)
        except Exception as e:
            logger.error(f"发送窗口事件失败: {e}")

    def get_foreground_window(self) -> Optional[WindowInfo]:
        """
        获取当前前台窗口信息
        :return: WindowInfo 对象或 None
        """
        try:
            # 获取前台窗口句柄
            hwnd = self._user32.GetForegroundWindow()
            if not hwnd:
                return None

            # 获取窗口标题
            title = self._get_window_title(hwnd)

            # 获取窗口类名
            class_name = self._get_window_class(hwnd)

            # 获取进程信息
            process_id = ctypes.wintypes.DWORD()
            self._user32.GetWindowThreadProcessId(hwnd, ctypes.byref(process_id))
            pid = process_id.value

            process_name, exe_path = self._get_process_info(pid)

            # 判断是否可见
            is_visible = bool(self._user32.IsWindowVisible(hwnd))

            return WindowInfo(
                hwnd=hwnd,
                title=title,
                class_name=class_name,
                process_name=process_name,
                exe_path=exe_path,
                process_id=pid,
                is_visible=is_visible
            )
        except Exception as e:
            logger.error(f"获取前台窗口信息失败: {e}")
            return None

    def _get_window_title(self, hwnd: int) -> str:
        """获取窗口标题"""
        try:
            length = self._user32.GetWindowTextLengthW(hwnd)
            if length == 0:
                return ""
            buf = ctypes.create_unicode_buffer(length + 1)
            self._user32.GetWindowTextW(hwnd, buf, length + 1)
            return buf.value
        except Exception:
            return ""

    def _get_window_class(self, hwnd: int) -> str:
        """获取窗口类名"""
        try:
            buf = ctypes.create_unicode_buffer(256)
            self._user32.GetClassNameW(hwnd, buf, 256)
            return buf.value
        except Exception:
            return ""

    def _get_process_info(self, pid: int) -> tuple:
        """
        获取进程名称和可执行文件路径
        :param pid: 进程ID
        :return: (进程名, 可执行路径)
        """
        process_name = ""
        exe_path = ""

        try:
            # 方法1: 使用 OpenProcess + GetModuleFileNameEx
            PROCESS_QUERY_INFORMATION = 0x0400
            PROCESS_VM_READ = 0x0010
            hProcess = self._kernel32.OpenProcess(
                PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid
            )

            if hProcess:
                try:
                    # 获取可执行文件路径
                    buf = ctypes.create_unicode_buffer(1024)
                    result = self._psapi.GetModuleFileNameExW(hProcess, None, buf, 1024)
                    if result > 0:
                        exe_path = buf.value
                        # 提取文件名作为进程名
                        process_name = exe_path.split('\\')[-1]
                except Exception:
                    pass
                finally:
                    self._kernel32.CloseHandle(hProcess)

            # 方法2: 如果方法1失败，使用 CreateToolhelp32Snapshot
            if not process_name:
                process_name = self._get_process_name_from_snapshot(pid)

        except Exception as e:
            logger.debug(f"获取进程信息失败 (PID={pid}): {e}")
            # 降级处理
            process_name = self._get_process_name_from_snapshot(pid)

        return process_name, exe_path

    def _get_process_name_from_snapshot(self, target_pid: int) -> str:
        """通过进程快照获取进程名"""
        try:
            TH32CS_SNAPPROCESS = 0x00000002
            hSnapshot = self._kernel32.CreateToolhelp32Snapshot(
                TH32CS_SNAPPROCESS, 0
            )

            if hSnapshot == -1:
                return ""

            try:
                pe = PROCESSENTRY32W()
                pe.dwSize = ctypes.sizeof(PROCESSENTRY32W)

                # 获取第一个进程
                if self._kernel32.Process32FirstW(hSnapshot, ctypes.byref(pe)):
                    while True:
                        if pe.th32ProcessID == target_pid:
                            return pe.szExeFile
                        if not self._kernel32.Process32NextW(hSnapshot, ctypes.byref(pe)):
                            break
            finally:
                self._kernel32.CloseHandle(hSnapshot)

        except Exception as e:
            logger.debug(f"进程快照查询失败: {e}")

        return ""

    def get_current_window(self) -> Optional[WindowInfo]:
        """获取当前窗口信息（线程安全）"""
        with self._lock:
            return self._current_window

    def get_statistics(self) -> Dict[str, Any]:
        """获取监控统计数据"""
        with self._lock:
            return {
                "switch_count": self._switch_count,
                "total_tracked_time": round(self._total_tracked_time, 1),
                "current_window": self._current_window.to_dict() if self._current_window else None
            }

    def enumerate_visible_windows(self) -> List[WindowInfo]:
        """
        枚举所有可见窗口
        :return: 可见窗口列表
        """
        windows = []

        def enum_callback(hwnd, lparam):
            if self._user32.IsWindowVisible(hwnd):
                title = self._get_window_title(hwnd)
                class_name = self._get_window_class(hwnd)

                # 过滤掉空标题和系统窗口
                if title.strip() and class_name not in ('IME', 'MSCTFIME UI'):
                    process_id = ctypes.wintypes.DWORD()
                    self._user32.GetWindowThreadProcessId(hwnd, ctypes.byref(process_id))
                    pid = process_id.value
                    process_name, exe_path = self._get_process_info(pid)

                    windows.append(WindowInfo(
                        hwnd=hwnd,
                        title=title,
                        class_name=class_name,
                        process_name=process_name,
                        exe_path=exe_path,
                        process_id=pid
                    ))
            return True

        try:
            callback = WNDENUMPROC(enum_callback)
            self._user32.EnumWindows(callback, 0)
        except Exception as e:
            logger.error(f"枚举窗口失败: {e}")

        return windows

    def shutdown(self):
        """关闭窗口监控器"""
        self.stop()
        logger.info("窗口监控器已关闭")
