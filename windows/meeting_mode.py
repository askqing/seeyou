#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
meeting_mode.py - 会议模式管理模块
负责会议模式的切换、自动检测（Outlook 日历）、以及相关状态通知。
当会议模式激活时，暂停所有监控并阻止截图请求。
"""

import logging
import threading
import time
from typing import Optional, Callable, List
from datetime import datetime, timedelta

logger = logging.getLogger(__name__)


class MeetingModeManager:
    """会议模式管理器"""

    # 会议模式状态
    MODE_OFF = "off"          # 正常监控模式
    MODE_MANUAL = "manual"    # 手动会议模式
    MODE_AUTO = "auto"        # 自动检测会议模式（Outlook）

    def __init__(self, api_client=None):
        """
        初始化会议模式管理器
        :param api_client: API 客户端实例，用于发送状态变更
        """
        self.api_client = api_client
        self._mode = self.MODE_OFF
        self._lock = threading.Lock()

        # Outlook 自动检测
        self._outlook_detection_enabled = False
        self._outlook_check_interval = 60  # 每60秒检查一次日历
        self._outlook_thread: Optional[threading.Thread] = None
        self._outlook_stop_event = threading.Event()

        # 状态变更回调列表
        self._on_mode_change_callbacks: List[Callable[[str, str], None]] = []

        logger.info("会议模式管理器初始化完成")

    @property
    def is_meeting(self) -> bool:
        """是否处于会议模式"""
        with self._lock:
            return self._mode != self.MODE_OFF

    @property
    def mode(self) -> str:
        """获取当前模式"""
        with self._lock:
            return self._mode

    def on_mode_change(self, callback: Callable[[str, str], None]):
        """
        注册模式变更回调
        :param callback: 回调函数 (old_mode, new_mode)
        """
        self._on_mode_change_callbacks.append(callback)

    def _notify_mode_change(self, old_mode: str, new_mode: str):
        """通知所有回调函数模式已变更"""
        for cb in self._on_mode_change_callbacks:
            try:
                cb(old_mode, new_mode)
            except Exception as e:
                logger.error(f"模式变更回调执行失败: {e}")

    def toggle(self) -> bool:
        """
        切换会议模式（手动）
        :return: 切换后的会议状态
        """
        with self._lock:
            if self._mode == self.MODE_OFF:
                old_mode = self._mode
                self._mode = self.MODE_MANUAL
                logger.info("会议模式已启用（手动）")
            else:
                old_mode = self._mode
                self._mode = self.MODE_OFF
                logger.info("会议模式已关闭")

            new_mode = self._mode
            is_meeting = self.is_meeting

        # 在锁外执行回调和网络请求
        self._notify_mode_change(old_mode, new_mode)

        # 通知服务器
        if self.api_client:
            try:
                self.api_client.send_meeting_mode_status(is_meeting)
            except Exception as e:
                logger.error(f"发送会议模式状态失败: {e}")

        return is_meeting

    def enable(self):
        """启用会议模式"""
        with self._lock:
            if self._mode == self.MODE_OFF:
                old_mode = self._mode
                self._mode = self.MODE_MANUAL
                new_mode = self._mode
                logger.info("会议模式已启用（手动）")
            else:
                return

        self._notify_mode_change(old_mode, new_mode)

        if self.api_client:
            try:
                self.api_client.send_meeting_mode_status(True)
            except Exception as e:
                logger.error(f"发送会议模式状态失败: {e}")

    def disable(self):
        """关闭会议模式"""
        with self._lock:
            if self._mode != self.MODE_OFF:
                old_mode = self._mode
                self._mode = self.MODE_OFF
                new_mode = self._mode
                logger.info("会议模式已关闭")
            else:
                return

        self._notify_mode_change(old_mode, new_mode)

        if self.api_client:
            try:
                self.api_client.send_meeting_mode_status(False)
            except Exception as e:
                logger.error(f"发送会议模式状态失败: {e}")

    def start_outlook_detection(self):
        """
        启动 Outlook 日历自动检测
        定期检查 Outlook 日历中的当前会议
        """
        with self._lock:
            if self._outlook_detection_enabled:
                logger.warning("Outlook 会议检测已在运行")
                return
            self._outlook_detection_enabled = True

        self._outlook_stop_event.clear()
        self._outlook_thread = threading.Thread(
            target=self._outlook_detection_loop,
            name="OutlookDetection",
            daemon=True
        )
        self._outlook_thread.start()
        logger.info("Outlook 会议自动检测已启动")

    def stop_outlook_detection(self):
        """停止 Outlook 日历自动检测"""
        with self._lock:
            if not self._outlook_detection_enabled:
                return
            self._outlook_detection_enabled = False

        self._outlook_stop_event.set()
        if self._outlook_thread and self._outlook_thread.is_alive():
            self._outlook_thread.join(timeout=10)
        logger.info("Outlook 会议自动检测已停止")

    def _outlook_detection_loop(self):
        """Outlook 日历检测主循环"""
        logger.info("Outlook 日历检测线程已启动")

        # 尝试导入 win32com，如果不可用则降级
        try:
            import win32com.client
        except ImportError:
            logger.warning("win32com 不可用，Outlook 会议检测无法启用")
            self._outlook_detection_enabled = False
            return

        while not self._outlook_stop_event.is_set():
            try:
                is_in_meeting = self._check_outlook_calendar(win32com.client)

                with self._lock:
                    current_mode = self._mode

                if is_in_meeting and current_mode == self.MODE_OFF:
                    # 自动进入会议模式
                    old_mode = current_mode
                    with self._lock:
                        self._mode = self.MODE_AUTO
                        new_mode = self._mode
                    logger.info("检测到 Outlook 会议，自动进入会议模式")
                    self._notify_mode_change(old_mode, new_mode)

                    if self.api_client:
                        try:
                            self.api_client.send_meeting_mode_status(True)
                        except Exception as e:
                            logger.error(f"发送会议模式状态失败: {e}")

                elif not is_in_meeting and current_mode == self.MODE_AUTO:
                    # 会议结束，自动退出会议模式
                    old_mode = current_mode
                    with self._lock:
                        self._mode = self.MODE_OFF
                        new_mode = self._mode
                    logger.info("Outlook 会议已结束，自动退出会议模式")
                    self._notify_mode_change(old_mode, new_mode)

                    if self.api_client:
                        try:
                            self.api_client.send_meeting_mode_status(False)
                        except Exception as e:
                            logger.error(f"发送会议模式状态失败: {e}")

            except Exception as e:
                logger.error(f"Outlook 日历检查出错: {e}")

            # 等待下一次检查
            self._outlook_stop_event.wait(self._outlook_check_interval)

        logger.info("Outlook 日历检测线程已退出")

    def _check_outlook_calendar(self, win32com_client) -> bool:
        """
        检查 Outlook 日历中是否有当前正在进行的会议
        :param win32com_client: win32com.client 模块
        :return: 是否有正在进行的会议
        """
        try:
            # 获取 Outlook 应用
            outlook = win32com_client.Dispatch("Outlook.Application")
            namespace = outlook.GetNamespace("MAPI")

            # 获取默认日历文件夹
            calendar = namespace.GetDefaultFolder(9)  # 9 = olFolderCalendar
            items = calendar.Items

            # 设置时间范围过滤
            now = datetime.now()
            start_time = now - timedelta(minutes=5)
            end_time = now + timedelta(minutes=5)

            # 使用 Restrict 过滤今日日程
            restrict_filter = (
                f"[Start] <= '{end_time.strftime('%Y-%m-%d %H:%M')}' "
                f"AND [End] >= '{start_time.strftime('%Y-%m-%d %H:%M')}'"
            )
            try:
                filtered_items = items.Restrict(restrict_filter)
            except Exception:
                # 过滤失败，回退到遍历
                filtered_items = items

            # 检查是否有匹配的会议
            for item in filtered_items:
                try:
                    item_start = item.Start
                    item_end = item.End

                    # 转换为 datetime 对象进行比较
                    if isinstance(item_start, str):
                        item_start = datetime.strptime(item_start[:19], '%Y-%m-%d %H:%M:%S')
                    if isinstance(item_end, str):
                        item_end = datetime.strptime(item_end[:19], '%Y-%m-%d %H:%M:%S')

                    if item_start <= now <= item_end:
                        # 检查是否为会议（有参与者）
                        subject = getattr(item, 'Subject', '')
                        if subject:
                            logger.info(f"检测到当前会议: {subject}")
                            return True
                except Exception as e:
                    logger.debug(f"日程项处理出错: {e}")
                    continue

            return False

        except Exception as e:
            # Outlook 可能未启动或不可用
            logger.debug(f"Outlook 访问失败: {e}")
            return False

    def get_status_text(self) -> str:
        """获取当前状态的文本描述"""
        with self._lock:
            mode = self._mode

        if mode == self.MODE_OFF:
            return "正常监控"
        elif mode == self.MODE_MANUAL:
            return "会议模式（手动）"
        elif mode == self.MODE_AUTO:
            return "会议模式（Outlook自动）"
        else:
            return "未知状态"

    def shutdown(self):
        """关闭会议模式管理器"""
        self.stop_outlook_detection()
        logger.info("会议模式管理器已关闭")
