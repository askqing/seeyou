#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
screen_capture.py - 截图捕获模块
使用 PIL/Pillow 捕获全屏或指定窗口截图，支持从服务器接收截图请求（轮询方式）。
截图以 base64 编码后上传到服务器。支持"压力测试"模式和会议模式下的截图拦截。
"""

import io
import base64
import logging
import threading
import time
from typing import Optional, Dict, Any, Callable, List

logger = logging.getLogger(__name__)

# 尝试导入 PIL
try:
    from PIL import Image, ImageGrab
    PIL_AVAILABLE = True
except ImportError:
    PIL_AVAILABLE = False
    logger.warning("Pillow 不可用，截图功能将被禁用")


class ScreenCapture:
    """屏幕截图捕获器"""

    def __init__(self, api_client=None, window_monitor=None,
                 meeting_mode_manager=None, config: Optional[Dict] = None):
        """
        初始化截图捕获器
        :param api_client: API 客户端实例
        :param window_monitor: 窗口监控器实例（用于获取当前窗口信息）
        :param meeting_mode_manager: 会议模式管理器
        :param config: 配置字典
        """
        self.api_client = api_client
        self.window_monitor = window_monitor
        self.meeting_mode_manager = meeting_mode_manager
        self.config = config or {}

        # 截图配置
        self.screenshot_quality = self.config.get('screenshot_quality', 80)
        self.poll_interval = self.config.get('poll_interval', 5)
        self.max_image_size = 1920  # 最大图片宽度（像素），超过则缩放

        # 截图请求轮询线程
        self._poll_thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._running = False

        # 压力测试模式
        self._stress_test_mode = False
        self._stress_test_thread: Optional[threading.Thread] = None

        # 统计数据
        self._capture_count = 0
        self._upload_count = 0
        self._blocked_count = 0  # 被会议模式拦截的次数
        self._error_count = 0

        # 截图事件回调
        self._on_capture_callbacks: List[Callable] = []

        logger.info(
            f"截图捕获器初始化完成 - "
            f"质量: {self.screenshot_quality}%, "
            f"轮询间隔: {self.poll_interval}s"
        )

    def on_capture(self, callback: Callable):
        """注册截图完成回调"""
        self._on_capture_callbacks.append(callback)

    def _notify_capture(self, success: bool, metadata: Dict = None):
        """通知截图完成"""
        for cb in self._on_capture_callbacks:
            try:
                cb(success, metadata)
            except Exception as e:
                logger.error(f"截图回调执行失败: {e}")

    def start(self):
        """启动截图请求轮询"""
        if not PIL_AVAILABLE:
            logger.error("Pillow 不可用，无法启动截图服务")
            return False

        if self._running:
            logger.warning("截图服务已在运行")
            return True

        self._stop_event.clear()
        self._running = True

        self._poll_thread = threading.Thread(
            target=self._poll_loop,
            name="ScreenshotPoll",
            daemon=True
        )
        self._poll_thread.start()
        logger.info("截图请求轮询已启动")
        return True

    def stop(self):
        """停止截图服务"""
        self._stop_event.set()
        self._running = False
        self._stress_test_mode = False

        if self._poll_thread and self._poll_thread.is_alive():
            self._poll_thread.join(timeout=10)

        if self._stress_test_thread and self._stress_test_thread.is_alive():
            self._stress_test_thread.join(timeout=10)

        logger.info("截图服务已停止")

    def _poll_loop(self):
        """截图请求轮询主循环"""
        logger.info("截图轮询线程已启动")

        while not self._stop_event.is_set():
            try:
                if self.api_client and not self._stress_test_mode:
                    # 向服务器轮询是否有截图请求
                    command = self.api_client.poll_commands()
                    if command:
                        self._handle_command(command)

            except Exception as e:
                logger.error(f"截图轮询出错: {e}")

            self._stop_event.wait(self.poll_interval)

        logger.info("截图轮询线程已退出")

    def _handle_command(self, command: Dict[str, Any]):
        """
        处理服务器命令
        :param command: 命令数据
        """
        cmd_type = command.get('type') or command.get('command')

        if cmd_type == 'screenshot' or cmd_type == 'capture':
            # 截图请求
            logger.info("收到服务器截图请求")
            self.capture_and_upload(
                command_id=command.get('id'),
                target=command.get('target', 'fullscreen'),  # 'fullscreen' or 'window'
                quality=command.get('quality', self.screenshot_quality)
            )

        elif cmd_type == 'stress_test_start':
            # 开始压力测试
            logger.info("收到压力测试启动命令")
            interval = command.get('interval', 1)
            count = command.get('count', 10)
            self.start_stress_test(interval=interval, count=count)

        elif cmd_type == 'stress_test_stop':
            # 停止压力测试
            logger.info("收到压力测试停止命令")
            self.stop_stress_test()

        elif cmd_type == 'calibrate':
            # 校准命令
            logger.info("收到校准命令")
            self.capture_and_upload(
                command_id=command.get('id'),
                target='fullscreen',
                quality=100
            )

        else:
            logger.debug(f"未知命令类型: {cmd_type}")

    def capture_fullscreen(self, quality: Optional[int] = None) -> Optional[str]:
        """
        捕获全屏截图
        :param quality: JPEG 质量 (1-100)
        :return: base64 编码的截图字符串或 None
        """
        if not PIL_AVAILABLE:
            logger.error("Pillow 不可用")
            return None

        quality = quality or self.screenshot_quality

        try:
            # 使用 PIL ImageGrab 捕获全屏
            screenshot = ImageGrab.grab()

            # 如果图片过大，进行缩放
            if screenshot.width > self.max_image_size:
                ratio = self.max_image_size / screenshot.width
                new_height = int(screenshot.height * ratio)
                screenshot = screenshot.resize(
                    (self.max_image_size, new_height),
                    Image.Resampling.LANCZOS
                )
                logger.debug(f"截图已缩放: {self.max_image_size}x{new_height}")

            # 转换为 base64
            img_buffer = io.BytesIO()
            screenshot.save(img_buffer, format='JPEG', quality=quality, optimize=True)
            img_buffer.seek(0)
            base64_str = base64.b64encode(img_buffer.read()).decode('utf-8')

            self._capture_count += 1
            logger.debug(f"全屏截图完成 - 大小: {len(base64_str) // 1024}KB")
            return base64_str

        except Exception as e:
            self._error_count += 1
            logger.error(f"全屏截图失败: {e}")
            return None

    def capture_window(self, quality: Optional[int] = None) -> Optional[str]:
        """
        捕获当前前台窗口截图
        :param quality: JPEG 质量 (1-100)
        :return: base64 编码的截图字符串或 None
        """
        if not PIL_AVAILABLE:
            logger.error("Pillow 不可用")
            return None

        quality = quality or self.screenshot_quality

        try:
            import ctypes
            import ctypes.wintypes

            user32 = ctypes.windll.user32

            # 获取前台窗口句柄和位置
            hwnd = user32.GetForegroundWindow()
            if not hwnd:
                logger.warning("无法获取前台窗口句柄")
                return None

            # 获取窗口矩形
            rect = ctypes.wintypes.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(rect))

            left = rect.left
            top = rect.top
            right = rect.right
            bottom = rect.bottom

            # 确保坐标有效
            if right <= left or bottom <= top:
                logger.warning(f"无效窗口矩形: ({left}, {top}, {right}, {bottom})")
                return None

            # 处理多显示器情况（负坐标）
            # PIL ImageGrab 可以处理负坐标
            bbox = (left, top, right, bottom)

            # 捕获指定区域
            screenshot = ImageGrab.grab(bbox=bbox)

            # 如果图片过大，进行缩放
            if screenshot.width > self.max_image_size:
                ratio = self.max_image_size / screenshot.width
                new_height = int(screenshot.height * ratio)
                screenshot = screenshot.resize(
                    (self.max_image_size, new_height),
                    Image.Resampling.LANCZOS
                )

            # 转换为 base64
            img_buffer = io.BytesIO()
            screenshot.save(img_buffer, format='JPEG', quality=quality, optimize=True)
            img_buffer.seek(0)
            base64_str = base64.b64encode(img_buffer.read()).decode('utf-8')

            self._capture_count += 1
            logger.debug(f"窗口截图完成 - 大小: {len(base64_str) // 1024}KB")
            return base64_str

        except Exception as e:
            self._error_count += 1
            logger.error(f"窗口截图失败: {e}")
            return None

    def capture_and_upload(self, command_id: Optional[str] = None,
                            target: str = 'fullscreen',
                            quality: Optional[int] = None) -> bool:
        """
        捕获截图并上传到服务器
        :param command_id: 命令ID（用于响应服务器请求）
        :param target: 截图目标 ('fullscreen' 或 'window')
        :param quality: JPEG 质量
        :return: 是否成功
        """
        quality = quality or self.screenshot_quality

        # 检查会议模式
        if self.meeting_mode_manager and self.meeting_mode_manager.is_meeting:
            self._blocked_count += 1
            logger.info("会议模式下阻止截图请求")

            # 通知服务器截图被阻止
            if self.api_client and command_id:
                try:
                    self.api_client._request('POST', '/api/screenshots/rejected', data={
                        "device_id": self.api_client.device_id,
                        "command_id": command_id,
                        "reason": "meeting_mode",
                        "timestamp": int(time.time() * 1000),
                        "session_id": self.api_client.session_id
                    })
                except Exception:
                    pass

            self._notify_capture(False, {"reason": "meeting_mode", "command_id": command_id})
            return False

        # 捕获截图
        if target == 'window':
            base64_img = self.capture_window(quality)
        else:
            base64_img = self.capture_fullscreen(quality)

        if not base64_img:
            self._notify_capture(False, {"reason": "capture_failed", "command_id": command_id})
            return False

        # 构建元数据
        metadata = {
            "target": target,
            "quality": quality,
            "command_id": command_id,
            "resolution": self._get_resolution()
        }

        # 附加当前窗口信息
        if self.window_monitor:
            current_window = self.window_monitor.get_current_window()
            if current_window:
                metadata["active_window"] = current_window.to_dict()

        # 上传到服务器
        if self.api_client:
            success = self.api_client.send_screenshot(base64_img, metadata)
            if success:
                self._upload_count += 1
                self._notify_capture(True, metadata)
                logger.info(f"截图上传成功 - 目标: {target}, 大小: {len(base64_img) // 1024}KB")
            else:
                self._error_count += 1
                self._notify_capture(False, {"reason": "upload_failed", "command_id": command_id})
                return False
        else:
            # 没有 API 客户端，仅保存到本地（调试用）
            logger.debug("无 API 客户端，截图未上传")
            self._notify_capture(True, metadata)

        return True

    def start_stress_test(self, interval: float = 1.0, count: int = 10):
        """
        启动压力测试模式 - 快速连续截图
        :param interval: 截图间隔（秒）
        :param count: 截图次数
        """
        if self._stress_test_mode:
            logger.warning("压力测试已在运行")
            return

        self._stress_test_mode = True
        self._stress_test_thread = threading.Thread(
            target=self._stress_test_loop,
            args=(interval, count),
            name="StressTest",
            daemon=True
        )
        self._stress_test_thread.start()
        logger.info(f"压力测试已启动 - 间隔: {interval}s, 次数: {count}")

    def stop_stress_test(self):
        """停止压力测试"""
        self._stress_test_mode = False
        logger.info("压力测试已停止")

    def _stress_test_loop(self, interval: float, count: int):
        """压力测试主循环"""
        captured = 0
        while self._stress_test_mode and captured < count:
            self.capture_and_upload(target='fullscreen')
            captured += 1
            time.sleep(interval)

        self._stress_test_mode = False
        logger.info(f"压力测试完成 - 共截图 {captured} 次")

    def _get_resolution(self) -> str:
        """获取当前屏幕分辨率"""
        try:
            import ctypes
            user32 = ctypes.windll.user32
            return f"{user32.GetSystemMetrics(0)}x{user32.GetSystemMetrics(1)}"
        except Exception:
            return "unknown"

    def get_statistics(self) -> Dict[str, Any]:
        """获取截图统计信息"""
        return {
            "capture_count": self._capture_count,
            "upload_count": self._upload_count,
            "blocked_count": self._blocked_count,
            "error_count": self._error_count,
            "stress_test_mode": self._stress_test_mode,
            "quality": self.screenshot_quality,
            "poll_interval": self.poll_interval
        }

    def set_quality(self, quality: int):
        """设置截图质量"""
        self.screenshot_quality = max(1, min(100, quality))
        logger.info(f"截图质量已更新: {self.screenshot_quality}%")

    def set_poll_interval(self, interval: float):
        """设置轮询间隔"""
        self.poll_interval = max(1, min(60, interval))
        logger.info(f"轮询间隔已更新: {self.poll_interval}s")

    def shutdown(self):
        """关闭截图服务"""
        self.stop()
        logger.info("截图服务已关闭")
