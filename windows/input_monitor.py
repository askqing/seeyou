#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
input_monitor.py - 输入设备空闲检测模块
使用 pynput 监控鼠标和键盘活动，检测空闲状态。
支持分类空闲类型：鼠标空闲、键盘空闲、系统空闲（两者均空闲）。
"""

import logging
import threading
import time
from typing import Optional, Dict, Any, Callable, List
from enum import Enum

logger = logging.getLogger(__name__)

# 尝试导入 pynput
try:
    from pynput import mouse, keyboard
    PYNPUT_AVAILABLE = True
except ImportError:
    PYNPUT_AVAILABLE = False
    logger.warning("pynput 不可用，输入设备监控将被禁用")


class IdleType(Enum):
    """空闲类型枚举"""
    NONE = "none"              # 无空闲
    MOUSE_IDLE = "mouse_idle"  # 仅鼠标空闲
    KEYBOARD_IDLE = "keyboard_idle"  # 仅键盘空闲
    SYSTEM_IDLE = "system_idle"  # 系统空闲（鼠标和键盘均空闲）


class InputMonitor:
    """输入设备空闲检测器"""

    # 默认空闲阈值（秒）
    DEFAULT_MOUSE_IDLE_THRESHOLD = 60    # 鼠标60秒无移动视为空闲
    DEFAULT_KEYBOARD_IDLE_THRESHOLD = 120  # 键盘120秒无输入视为空闲

    def __init__(self, api_client=None,
                 mouse_idle_threshold: float = DEFAULT_MOUSE_IDLE_THRESHOLD,
                 keyboard_idle_threshold: float = DEFAULT_KEYBOARD_IDLE_THRESHOLD,
                 check_interval: float = 5.0):
        """
        初始化输入设备监控器
        :param api_client: API 客户端实例
        :param mouse_idle_threshold: 鼠标空闲阈值（秒）
        :param keyboard_idle_threshold: 键盘空闲阈值（秒）
        :param check_interval: 空闲检查间隔（秒）
        """
        self.api_client = api_client
        self.mouse_idle_threshold = mouse_idle_threshold
        self.keyboard_idle_threshold = keyboard_idle_threshold
        self.check_interval = check_interval

        # 最后活动时间戳
        self._last_mouse_activity = time.time()
        self._last_keyboard_activity = time.time()
        self._lock = threading.Lock()

        # 当前空闲状态
        self._current_idle_type = IdleType.NONE
        self._idle_start_time: Optional[float] = None
        self._last_reported_idle_type = IdleType.NONE

        # pynput 监听器
        self._mouse_listener = None
        self._keyboard_listener = None

        # 检查线程
        self._check_thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._running = False

        # 空闲状态变更回调
        self._on_idle_change_callbacks: List[Callable[[IdleType, float], None]] = []

        # 累计空闲统计
        self._total_idle_time = 0.0  # 系统总空闲时间
        self._idle_count = 0         # 空闲次数

        logger.info(
            f"输入设备监控器初始化完成 - "
            f"鼠标阈值: {mouse_idle_threshold}s, "
            f"键盘阈值: {keyboard_idle_threshold}s"
        )

    def on_idle_change(self, callback: Callable[[IdleType, float], None]):
        """
        注册空闲状态变更回调
        :param callback: 回调函数 (idle_type, idle_duration_seconds)
        """
        self._on_idle_change_callbacks.append(callback)

    def _notify_idle_change(self, idle_type: IdleType, duration: float):
        """通知空闲状态变更"""
        for cb in self._on_idle_change_callbacks:
            try:
                cb(idle_type, duration)
            except Exception as e:
                logger.error(f"空闲状态变更回调执行失败: {e}")

    def _on_mouse_move(self, x, y):
        """鼠标移动事件处理"""
        with self._lock:
            self._last_mouse_activity = time.time()

    def _on_mouse_click(self, x, y, button, pressed):
        """鼠标点击事件处理"""
        with self._lock:
            self._last_mouse_activity = time.time()

    def _on_mouse_scroll(self, x, y, dx, dy):
        """鼠标滚轮事件处理"""
        with self._lock:
            self._last_mouse_activity = time.time()

    def _on_key_press(self, key):
        """键盘按键事件处理"""
        with self._lock:
            self._last_keyboard_activity = time.time()

    def start(self):
        """启动输入设备监控"""
        if not PYNPUT_AVAILABLE:
            logger.error("pynput 不可用，无法启动输入设备监控")
            return False

        if self._running:
            logger.warning("输入设备监控已在运行")
            return True

        self._stop_event.clear()
        self._running = True

        # 初始化活动时间戳
        now = time.time()
        with self._lock:
            self._last_mouse_activity = now
            self._last_keyboard_activity = now

        # 启动鼠标监听
        try:
            self._mouse_listener = mouse.Listener(
                on_move=self._on_mouse_move,
                on_click=self._on_mouse_click,
                on_scroll=self._on_mouse_scroll
            )
            self._mouse_listener.daemon = True
            self._mouse_listener.start()
            logger.info("鼠标监听已启动")
        except Exception as e:
            logger.error(f"鼠标监听启动失败: {e}")
            return False

        # 启动键盘监听
        try:
            self._keyboard_listener = keyboard.Listener(
                on_press=self._on_key_press
            )
            self._keyboard_listener.daemon = True
            self._keyboard_listener.start()
            logger.info("键盘监听已启动")
        except Exception as e:
            logger.error(f"键盘监听启动失败: {e}")
            self.stop()
            return False

        # 启动空闲检查线程
        self._check_thread = threading.Thread(
            target=self._idle_check_loop,
            name="InputIdleCheck",
            daemon=True
        )
        self._check_thread.start()
        logger.info("输入设备空闲检测已启动")

        return True

    def stop(self):
        """停止输入设备监控"""
        self._stop_event.set()
        self._running = False

        # 停止监听器
        if self._mouse_listener:
            try:
                self._mouse_listener.stop()
            except Exception:
                pass
            self._mouse_listener = None

        if self._keyboard_listener:
            try:
                self._keyboard_listener.stop()
            except Exception:
                pass
            self._keyboard_listener = None

        # 等待检查线程退出
        if self._check_thread and self._check_thread.is_alive():
            self._check_thread.join(timeout=10)

        logger.info("输入设备空闲检测已停止")

    def _idle_check_loop(self):
        """空闲状态检查主循环"""
        logger.info("空闲检查线程已启动")

        while not self._stop_event.is_set():
            try:
                self._check_idle_state()
            except Exception as e:
                logger.error(f"空闲状态检查出错: {e}")

            self._stop_event.wait(self.check_interval)

        # 发送最后一次空闲状态（如果仍空闲）
        self._check_idle_state(force_report=True)
        logger.info("空闲检查线程已退出")

    def _check_idle_state(self, force_report: bool = False):
        """检查当前空闲状态"""
        now = time.time()

        with self._lock:
            mouse_idle_duration = now - self._last_mouse_activity
            keyboard_idle_duration = now - self._last_keyboard_activity

        # 判断各类空闲
        mouse_idle = mouse_idle_duration >= self.mouse_idle_threshold
        keyboard_idle = keyboard_idle_duration >= self.keyboard_idle_threshold

        # 确定空闲类型
        if mouse_idle and keyboard_idle:
            current_idle = IdleType.SYSTEM_IDLE
        elif mouse_idle:
            current_idle = IdleType.MOUSE_IDLE
        elif keyboard_idle:
            current_idle = IdleType.KEYBOARD_IDLE
        else:
            current_idle = IdleType.NONE

        # 更新空闲状态
        if current_idle != IdleType.NONE:
            if self._current_idle_type == IdleType.NONE:
                # 刚进入空闲状态
                self._idle_start_time = now
                self._idle_count += 1
                logger.info(f"进入空闲状态: {current_idle.value}")
            elif self._current_idle_type != current_idle:
                # 空闲类型变化
                logger.info(f"空闲类型变化: {self._current_idle_type.value} -> {current_idle.value}")
        else:
            if self._current_idle_type != IdleType.NONE:
                # 从空闲恢复
                if self._idle_start_time:
                    idle_duration = now - self._idle_start_time
                    self._total_idle_time += idle_duration
                    logger.info(
                        f"从空闲恢复，空闲持续: {idle_duration:.1f}s, "
                        f"类型: {self._current_idle_type.value}"
                    )
                self._idle_start_time = None

        self._current_idle_type = current_idle

        # 计算空闲持续时间
        idle_duration = 0.0
        if self._idle_start_time:
            idle_duration = now - self._idle_start_time

        # 状态变更或定期报告
        if force_report or current_idle != self._last_reported_idle_type:
            self._last_reported_idle_type = current_idle
            self._notify_idle_change(current_idle, idle_duration)
            self._report_idle_to_server(current_idle, idle_duration,
                                        mouse_idle_duration, keyboard_idle_duration)

    def _report_idle_to_server(self, idle_type: IdleType, idle_duration: float,
                                mouse_idle_duration: float, keyboard_idle_duration: float):
        """向服务器报告空闲状态"""
        if not self.api_client:
            return

        data = {
            "idle_type": idle_type.value,
            "idle_duration_seconds": round(idle_duration, 1),
            "mouse_idle_seconds": round(mouse_idle_duration, 1),
            "keyboard_idle_seconds": round(keyboard_idle_duration, 1),
            "mouse_idle_threshold": self.mouse_idle_threshold,
            "keyboard_idle_threshold": self.keyboard_idle_threshold,
            "total_idle_time_seconds": round(self._total_idle_time, 1),
            "idle_count": self._idle_count
        }

        try:
            self.api_client.send_input_idle(data)
        except Exception as e:
            logger.error(f"发送空闲状态失败: {e}")

    def get_status(self) -> Dict[str, Any]:
        """
        获取当前输入设备状态
        :return: 状态字典
        """
        now = time.time()
        with self._lock:
            mouse_idle_duration = now - self._last_mouse_activity
            keyboard_idle_duration = now - self._last_keyboard_activity

        return {
            "idle_type": self._current_idle_type.value,
            "mouse_idle_duration": round(mouse_idle_duration, 1),
            "keyboard_idle_duration": round(keyboard_idle_duration, 1),
            "mouse_idle_threshold": self.mouse_idle_threshold,
            "keyboard_idle_threshold": self.keyboard_idle_threshold,
            "total_idle_time": round(self._total_idle_time, 1),
            "idle_count": self._idle_count,
            "current_idle_duration": round(
                now - self._idle_start_time if self._idle_start_time else 0, 1
            )
        }

    def set_mouse_threshold(self, threshold: float):
        """设置鼠标空闲阈值"""
        self.mouse_idle_threshold = threshold
        logger.info(f"鼠标空闲阈值已更新: {threshold}s")

    def set_keyboard_threshold(self, threshold: float):
        """设置键盘空闲阈值"""
        self.keyboard_idle_threshold = threshold
        logger.info(f"键盘空闲阈值已更新: {threshold}s")

    def shutdown(self):
        """关闭输入设备监控器"""
        self.stop()
        logger.info("输入设备监控器已关闭")
