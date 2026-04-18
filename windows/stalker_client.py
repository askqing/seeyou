#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
stalker_client.py - 视奸面板 Windows 客户端主程序
系统托盘应用，整合所有监控模块，管理后台服务和 UI 交互。
"""

import os
import sys
import time
import logging
import threading
import signal
import base64
from typing import Optional

# 设置日志
def setup_logging():
    """配置日志系统"""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    log_dir = os.path.join(script_dir, 'logs')
    if not os.path.exists(log_dir):
        os.makedirs(log_dir)

    log_file = os.path.join(log_dir, 'stalker_client.log')

    # 配置根日志记录器
    formatter = logging.Formatter(
        '%(asctime)s [%(levelname)s] [%(threadName)s] %(name)s: %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    )

    # 文件处理器（滚动日志）
    from logging.handlers import RotatingFileHandler
    file_handler = RotatingFileHandler(
        log_file, maxBytes=5*1024*1024, backupCount=5,
        encoding='utf-8'
    )
    file_handler.setLevel(logging.DEBUG)
    file_handler.setFormatter(formatter)

    # 控制台处理器
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(logging.INFO)
    console_handler.setFormatter(formatter)

    # 根日志器
    root_logger = logging.getLogger()
    root_logger.setLevel(logging.DEBUG)
    root_logger.addHandler(file_handler)
    root_logger.addHandler(console_handler)

    # 降低第三方库的日志级别
    logging.getLogger('urllib3').setLevel(logging.WARNING)
    logging.getLogger('requests').setLevel(logging.WARNING)
    logging.getLogger('pynput').setLevel(logging.WARNING)

    return log_file

setup_logging()
logger = logging.getLogger(__name__)

# ==================== 导入依赖 ====================
try:
    import ctypes
    import ctypes.wintypes
except ImportError:
    logger.error("ctypes 不可用，此程序仅在 Windows 上运行")
    sys.exit(1)

try:
    import win32gui
    import win32con
    import win32api
except ImportError:
    logger.warning("pywin32 不完整，部分功能可能受限")
    win32gui = None
    win32con = None
    win32api = None

try:
    from PIL import Image, ImageDraw
    PIL_AVAILABLE = True
except ImportError:
    PIL_AVAILABLE = False
    logger.warning("Pillow 不可用，图标生成和截图功能将被禁用")

try:
    import tkinter as tk
    from tkinter import messagebox
    TKINTER_AVAILABLE = True
except ImportError:
    TKINTER_AVAILABLE = False
    logger.warning("tkinter 不可用，设置对话框将被禁用")

# ==================== 导入项目模块 ====================
from api_client import APIClient
from window_monitor import WindowMonitor, WindowInfo
from screen_capture import ScreenCapture
from taskbar_monitor import TaskbarMonitor
from heatmap_data import HeatmapDataCollector
from input_monitor import InputMonitor
from meeting_mode import MeetingModeManager
from settings_dialog import SettingsDialog


class StalkerTrayApp:
    """视奸面板系统托盘应用"""

    # 图标颜色常量
    ICON_COLOR_NORMAL = (76, 175, 80)       # 绿色 - 正常监控
    ICON_COLOR_MEETING = (244, 67, 54)      # 红色 - 会议模式
    ICON_COLOR_DISCONNECTED = (158, 158, 158)  # 灰色 - 未连接

    def __init__(self):
        """初始化托盘应用"""
        # 加载配置
        self.settings_dialog = SettingsDialog(
            config_path='config.json',
            on_save=self._on_settings_changed
        )
        self.config = self.settings_dialog.get_config()

        # 初始化 API 客户端
        self.api_client = APIClient(
            server_url=self.config['server_url'],
            device_name=self.config['device_name'],
            config=self.config
        )

        # 初始化会议模式管理器
        self.meeting_mode_manager = MeetingModeManager(api_client=self.api_client)
        self.meeting_mode_manager.on_mode_change(self._on_meeting_mode_changed)

        # 初始化窗口监控器
        self.window_monitor = WindowMonitor(
            api_client=self.api_client,
            poll_interval=0.5
        )
        self.window_monitor.on_window_change(self._on_window_changed)

        # 初始化截图捕获器
        self.screen_capture = ScreenCapture(
            api_client=self.api_client,
            window_monitor=self.window_monitor,
            meeting_mode_manager=self.meeting_mode_manager,
            config=self.config
        )

        # 初始化热力图数据收集器
        self.heatmap_collector = HeatmapDataCollector(
            api_client=self.api_client,
            report_interval=self.config.get('upload_interval', 5) * 60  # 转换为秒
        )
        self.heatmap_collector.on_switch(self._on_heatmap_switch)

        # 初始化输入设备监控器
        self.input_monitor = InputMonitor(
            api_client=self.api_client
        )

        # 初始化任务栏监控器
        self.taskbar_monitor = TaskbarMonitor(
            api_client=self.api_client,
            check_interval=30.0
        )

        # 注册连接状态回调
        self.api_client.on_disconnect(self._on_server_disconnect)
        self.api_client.on_reconnect(self._on_server_reconnect)

        # 系统托盘相关
        self._hwnd = 0
        self._tray_icon_id = 0
        self._message_map = {}
        self._running = False
        self._icon_data = None

        # 心跳线程
        self._heartbeat_thread: Optional[threading.Thread] = None

        logger.info("视奸面板客户端初始化完成")

    def run(self):
        """启动应用程序"""
        logger.info("=" * 60)
        logger.info("  视奸面板 Windows 客户端 v1.0.0")
        logger.info("=" * 60)

        # 1. 注册设备
        logger.info("正在向服务器注册设备...")
        if not self.api_client.register_device():
            logger.warning("设备注册失败，将在连接恢复后重试")

        # 2. 启动窗口监控
        logger.info("正在启动窗口监控...")
        self.window_monitor.start()

        # 3. 启动输入设备监控
        logger.info("正在启动输入设备监控...")
        self.input_monitor.start()

        # 4. 启动截图服务
        logger.info("正在启动截图服务...")
        self.screen_capture.start()

        # 5. 启动热力图数据收集
        logger.info("正在启动热力图数据收集...")
        self.heatmap_collector.start()

        # 6. 启动任务栏监控
        logger.info("正在启动任务栏监控...")
        self.taskbar_monitor.start()

        # 7. 启动心跳线程
        self._start_heartbeat()

        # 8. 启动系统托盘 UI
        logger.info("正在启动系统托盘...")
        self._running = True
        self._create_tray_icon()

        logger.info("所有模块已启动，应用运行中")

        # 主循环（由 Windows 消息循环接管）
        try:
            self._message_loop()
        except KeyboardInterrupt:
            logger.info("收到键盘中断信号")
        except Exception as e:
            logger.error(f"主循环异常: {e}")
        finally:
            self.shutdown()

    def _create_tray_icon(self):
        """创建系统托盘图标"""
        if not win32gui:
            logger.error("win32gui 不可用，无法创建托盘图标")
            return

        # 生成默认图标（绿色）
        self._icon_data = self._create_icon_data(self.ICON_COLOR_NORMAL)

        # 注册窗口类
        wc = win32gui.WNDCLASS()
        wc.hInstance = win32api.GetModuleHandle(None)
        wc.lpszClassName = "StalkerPanelTray"
        wc.lpfnWndProc = self._tray_wnd_proc
        class_atom = win32gui.RegisterClass(wc)

        # 创建隐藏窗口（用于接收托盘消息）
        self._hwnd = win32gui.CreateWindow(
            class_atom, "StalkerPanel", 0, 0, 0, 0, 0, 0, 0, wc.hInstance, None
        )

        # 添加托盘图标
        self._update_tray_icon()

        logger.info("系统托盘图标已创建")

    def _create_icon_data(self, color: tuple, size: int = 32) -> bytes:
        """
        生成 ICO 格式图标数据
        :param color: RGB 颜色元组
        :param size: 图标尺寸
        :return: ICO 数据
        """
        if not PIL_AVAILABLE:
            return self._create_default_icon()

        try:
            # 创建图标图像
            img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
            draw = ImageDraw.Draw(img)

            # 绘制圆形背景
            margin = 2
            draw.ellipse(
                [margin, margin, size - margin - 1, size - margin - 1],
                fill=color + (255,),
                outline=(255, 255, 255, 200),
                width=2
            )

            # 绘制内部监控符号（眼睛形状简化版）
            center = size // 2
            eye_w = size // 3
            eye_h = size // 5

            # 外眼轮廓
            draw.ellipse(
                [center - eye_w, center - eye_h, center + eye_w, center + eye_h],
                fill=(255, 255, 255, 240),
                outline=color + (255,),
                width=1
            )

            # 瞳孔
            pupil_r = size // 8
            draw.ellipse(
                [center - pupil_r, center - pupil_r, center + pupil_r, center + pupil_r],
                fill=color + (255,)
            )

            # 保存为 ICO 格式
            icon_buffer = self._image_to_ico(img, size)
            return icon_buffer

        except Exception as e:
            logger.error(f"图标生成失败: {e}")
            return self._create_default_icon()

    def _image_to_ico(self, img: 'Image.Image', size: int) -> bytes:
        """将 PIL 图像转换为 ICO 格式 bytes"""
        import struct
        import io

        # 创建 BMP 数据
        bmp_buffer = io.BytesIO()

        # 转换为 BGRA（ICO 使用 BGRA）
        img_bgra = img.convert('RGBA')
        pixels = img_bgra.tobytes()

        # 构建 ICO 文件结构
        # ICO Header (6 bytes)
        ico_header = struct.pack('<HHH', 0, 1, 1)  # 保留, 类型(1=ICO), 数量

        # ICO Directory Entry (16 bytes)
        bmp_data_len = 40 + len(pixels)  # BITMAPINFOHEADER + pixel data
        ico_entry = struct.pack(
            '<BBBBHHII',
            size if size < 256 else 0,  # 宽度
            size if size < 256 else 0,  # 高度
            0,                          # 调色板数量
            0,                          # 保留
            1,                          # 色彩平面
            32,                         # 位深度
            bmp_data_len,               # 数据大小
            22                          # 数据偏移 (6 + 16)
        )

        # BITMAPINFOHEADER (40 bytes)
        bmp_header = struct.pack(
            '<IiiHHIIiiII',
            40,                     # 结构体大小
            size,                   # 宽度
            size * 2,               # 高度 (ICO 中高度是 2x)
            1,                      # 色彩平面
            32,                     # 位深度
            0,                      # 压缩方式
            len(pixels),            # 图像数据大小
            0, 0,                   # 水平/垂直分辨率
            0,                      # 使用的颜色数
            0                       # 重要的颜色数
        )

        ico_data = ico_header + ico_entry + bmp_header + pixels
        return ico_data

    def _create_default_icon(self) -> bytes:
        """创建默认的简单图标（不依赖 PIL）"""
        import struct
        size = 16
        # 简单的 16x16 绿色图标
        pixels = b''
        for y in range(size):
            for x in range(size):
                # 简单圆形
                cx, cy = size // 2, size // 2
                dist = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
                if dist <= size // 2:
                    pixels += b'\x4C\xAF\x50\xFF'  # BGRA green
                else:
                    pixels += b'\x00\x00\x00\x00'  # 透明

        ico_header = struct.pack('<HHH', 0, 1, 1)
        bmp_data_len = 40 + len(pixels)
        ico_entry = struct.pack('<BBBBHHII', size, size, 0, 0, 1, 32, bmp_data_len, 22)
        bmp_header = struct.pack('<IiiHHIIiiII', 40, size, size * 2, 1, 32, 0, len(pixels), 0, 0, 0, 0)

        return ico_header + ico_entry + bmp_header + pixels

    def _update_tray_icon(self):
        """更新托盘图标"""
        if not win32gui or not self._hwnd:
            return

        # 确定图标颜色
        if self.meeting_mode_manager.is_meeting:
            if self._icon_data is None or self.meeting_mode_manager.mode == MeetingModeManager.MODE_MANUAL:
                self._icon_data = self._create_icon_data(self.ICON_COLOR_MEETING)
            elif self.meeting_mode_manager.mode == MeetingModeManager.MODE_AUTO:
                self._icon_data = self._create_icon_data(self.ICON_COLOR_MEETING)
        elif not self.api_client.connected:
            self._icon_data = self._create_icon_data(self.ICON_COLOR_DISCONNECTED)
        else:
            self._icon_data = self._create_icon_data(self.ICON_COLOR_NORMAL)

        # 确定 tooltip 文字
        tooltip = self._get_status_tooltip()

        try:
            # NIM_MODIFY = 1
            win32gui.Shell_NotifyIcon(
                win32con.NIM_MODIFY if self._tray_icon_id else win32con.NIM_ADD,
                (
                    self._hwnd,  # 窗口句柄
                    0,           # 图标ID
                    win32con.NIF_MESSAGE | win32con.NIF_ICON | win32con.NIF_TIP,
                    0x0400,      # WM_USER + 1024 (托盘回调消息)
                    self._icon_data,  # 图标数据
                    tooltip       # 提示文字
                )
            )
            self._tray_icon_id = 1
        except Exception as e:
            logger.error(f"更新托盘图标失败: {e}")

    def _get_status_tooltip(self) -> str:
        """获取状态提示文字"""
        base = f"视奸面板 - {self.config['device_name']}"
        if self.meeting_mode_manager.is_meeting:
            return f"{base} [会议模式]"
        elif not self.api_client.connected:
            return f"{base} [未连接]"
        else:
            return f"{base} [监控中]"

    def _tray_wnd_proc(self, hwnd, msg, wparam, lparam):
        """托盘窗口消息处理"""
        if msg == 0x0400:  # WM_USER + 1024 (托盘回调消息)
            if lparam == win32con.WM_RBUTTONUP:
                # 右键点击 - 显示菜单
                self._show_tray_menu()
            elif lparam == win32con.WM_LBUTTONDBLCLK:
                # 双击 - 手动截图
                self._manual_screenshot()
            return 0

        elif msg == win32con.WM_DESTROY:
            win32gui.PostQuitMessage(0)
            return 0

        return win32gui.DefWindowProc(hwnd, msg, wparam, lparam)

    def _show_tray_menu(self):
        """显示托盘右键菜单"""
        if not win32gui:
            return

        menu = win32gui.CreatePopupMenu()

        # 状态项
        status_text = self.meeting_mode_manager.get_status_text()
        if not self.api_client.connected:
            status_text = "未连接"
        win32gui.AppendMenu(menu, win32con.MF_STRING | win32con.MF_DISABLED,
                            1000, f"状态: {status_text}")

        # 分隔线
        win32gui.AppendMenu(menu, win32con.MF_SEPARATOR, 0, "")

        # 会议模式切换
        if self.meeting_mode_manager.is_meeting:
            win32gui.AppendMenu(menu, win32con.MF_STRING, 2001, "✓ 切换会议模式 (已开启)")
        else:
            win32gui.AppendMenu(menu, win32con.MF_STRING, 2001, "  切换会议模式")

        # 分隔线
        win32gui.AppendMenu(menu, win32con.MF_SEPARATOR, 0, "")

        # 手动截图
        win32gui.AppendMenu(menu, win32con.MF_STRING, 3001, "手动截图")
        # 发送心跳
        win32gui.AppendMenu(menu, win32con.MF_STRING, 3002, "立即发送心跳")

        # 分隔线
        win32gui.AppendMenu(menu, win32con.MF_SEPARATOR, 0, "")

        # Outlook 自动检测
        if self.meeting_mode_manager._outlook_detection_enabled:
            win32gui.AppendMenu(menu, win32con.MF_STRING, 4001,
                                "✓ Outlook会议自动检测 (已开启)")
        else:
            win32gui.AppendMenu(menu, win32con.MF_STRING, 4001,
                                "  Outlook会议自动检测")

        # 设置
        win32gui.AppendMenu(menu, win32con.MF_STRING, 4002, "设置...")

        # 分隔线
        win32gui.AppendMenu(menu, win32con.MF_SEPARATOR, 0, "")

        # 刷新离线队列
        win32gui.AppendMenu(menu, win32con.MF_STRING, 5001,
                            f"刷新离线队列 ({self.api_client.offline_queue.size()} 条)")

        # 退出
        win32gui.AppendMenu(menu, win32con.MF_STRING, 6001, "退出")

        # 显示菜单
        try:
            win32gui.SetForegroundWindow(self._hwnd)
            cursor_pos = win32gui.GetCursorPos()
            cmd = win32gui.TrackPopupMenu(
                menu,
                win32con.TPM_RETURNCMD | win32con.TPM_NONOTIFY,
                cursor_pos[0], cursor_pos[1],
                0, self._hwnd, None
            )
            win32gui.PostMessage(self._hwnd, win32con.WM_NULL, 0, 0)
        finally:
            win32gui.DestroyMenu(menu)

        # 处理菜单选择
        self._handle_menu_command(cmd)

    def _handle_menu_command(self, cmd: int):
        """处理菜单命令"""
        if cmd == 2001:
            # 切换会议模式
            self.meeting_mode_manager.toggle()
            self._update_tray_icon()

        elif cmd == 3001:
            # 手动截图
            self._manual_screenshot()

        elif cmd == 3002:
            # 立即发送心跳
            threading.Thread(target=self.api_client.send_heartbeat, daemon=True).start()
            logger.info("手动发送心跳")

        elif cmd == 4001:
            # Outlook 自动检测
            if self.meeting_mode_manager._outlook_detection_enabled:
                self.meeting_mode_manager.stop_outlook_detection()
            else:
                self.meeting_mode_manager.start_outlook_detection()

        elif cmd == 4002:
            # 打开设置对话框（在新线程中，避免阻塞消息循环）
            threading.Thread(target=self._open_settings, daemon=True).start()

        elif cmd == 5001:
            # 刷新离线队列
            threading.Thread(
                target=self.api_client.flush_offline_queue,
                daemon=True
            ).start()
            logger.info("手动刷新离线队列")

        elif cmd == 6001:
            # 退出
            logger.info("用户选择退出")
            self._running = False
            if self._hwnd:
                win32gui.PostMessage(self._hwnd, win32con.WM_DESTROY, 0, 0)

    def _manual_screenshot(self):
        """手动截图"""
        logger.info("执行手动截图...")
        threading.Thread(
            target=self.screen_capture.capture_and_upload,
            kwargs={"target": "fullscreen"},
            daemon=True
        ).start()

    def _open_settings(self):
        """在新线程中打开设置对话框"""
        try:
            self.settings_dialog.show()
            # 对话框关闭后刷新图标（tooltip 可能已变化）
            self._update_tray_icon()
        except Exception as e:
            logger.error(f"打开设置对话框失败: {e}")

    def _message_loop(self):
        """Windows 消息循环"""
        if win32gui and self._hwnd:
            win32gui.PumpMessages()
        else:
            # 无 win32gui 时使用简单的 sleep 循环
            while self._running:
                time.sleep(1)

    def _start_heartbeat(self):
        """启动心跳线程"""
        interval = self.config.get('heartbeat_interval', 30)

        def heartbeat_loop():
            logger.info(f"心跳线程已启动 - 间隔: {interval}s")
            while self._running:
                try:
                    # 发送心跳
                    self.api_client.send_heartbeat()

                    # 刷新离线队列
                    if self.api_client.offline_queue.size() > 0:
                        self.api_client.flush_offline_queue()

                    # 更新托盘图标状态
                    self._update_tray_icon()

                except Exception as e:
                    logger.error(f"心跳发送失败: {e}")

                # 等待下一次心跳
                for _ in range(int(interval)):
                    if not self._running:
                        break
                    time.sleep(1)

            logger.info("心跳线程已退出")

        self._heartbeat_thread = threading.Thread(
            target=heartbeat_loop,
            name="Heartbeat",
            daemon=True
        )
        self._heartbeat_thread.start()

    # ==================== 事件回调 ====================

    def _on_window_changed(self, new_window: WindowInfo,
                            old_window: Optional[WindowInfo], duration: float):
        """窗口切换事件回调"""
        # 记录到热力图
        self.heatmap_collector.record_switch(
            window_title=new_window.title,
            process_name=new_window.process_name,
            class_name=new_window.class_name,
            exe_path=new_window.exe_path
        )

    def _on_meeting_mode_changed(self, old_mode: str, new_mode: str):
        """会议模式变更回调"""
        logger.info(f"会议模式变更: {old_mode} -> {new_mode}")
        # 更新托盘图标
        self._update_tray_icon()

    def _on_heatmap_switch(self, record):
        """热力图记录回调"""
        pass  # 由 heatmap_collector 内部处理

    def _on_server_disconnect(self):
        """服务器断开连接回调"""
        logger.warning("服务器连接已断开")
        self._update_tray_icon()

    def _on_server_reconnect(self):
        """服务器重新连接回调"""
        logger.info("服务器连接已恢复")
        self._update_tray_icon()

    def _on_settings_changed(self, new_config: dict):
        """设置变更回调"""
        logger.info("设置已更新，应用新配置...")

        # 更新 API 客户端
        if new_config.get('server_url') != self.config.get('server_url'):
            self.api_client.update_server_url(new_config['server_url'])

        if new_config.get('device_name') != self.config.get('device_name'):
            self.api_client.update_device_name(new_config['device_name'])

        # 更新截图设置
        if 'screenshot_quality' in new_config:
            self.screen_capture.set_quality(new_config['screenshot_quality'])

        if 'poll_interval' in new_config:
            self.screen_capture.set_poll_interval(new_config['poll_interval'])

        # 更新本地配置
        self.config.update(new_config)

        # 更新托盘图标
        self._update_tray_icon()

        logger.info("新配置已应用")

    # ==================== 关闭 ====================

    def shutdown(self):
        """关闭应用程序"""
        logger.info("正在关闭应用程序...")

        self._running = False

        # 停止各模块
        logger.info("正在停止输入设备监控...")
        self.input_monitor.shutdown()

        logger.info("正在停止窗口监控...")
        self.window_monitor.shutdown()

        logger.info("正在停止截图服务...")
        self.screen_capture.shutdown()

        logger.info("正在停止热力图收集...")
        self.heatmap_collector.shutdown()

        logger.info("正在停止任务栏监控...")
        self.taskbar_monitor.shutdown()

        logger.info("正在停止会议模式管理...")
        self.meeting_mode_manager.shutdown()

        # 移除托盘图标
        if win32gui and self._hwnd:
            try:
                win32gui.Shell_NotifyIcon(win32con.NIM_DELETE, (self._hwnd, 0))
            except Exception:
                pass
            try:
                win32gui.DestroyWindow(self._hwnd)
                win32gui.UnregisterClass("StalkerPanelTray",
                                          win32api.GetModuleHandle(None))
            except Exception:
                pass

        # 打印最终统计
        self._print_statistics()

        logger.info("应用程序已关闭")
        logging.shutdown()

    def _print_statistics(self):
        """打印运行统计"""
        logger.info("=" * 60)
        logger.info("  运行统计摘要")
        logger.info("=" * 60)

        # 窗口监控统计
        win_stats = self.window_monitor.get_statistics()
        logger.info(f"窗口切换次数: {win_stats['switch_count']}")
        logger.info(f"总追踪时间: {win_stats['total_tracked_time']:.1f}s")

        # 截图统计
        ss_stats = self.screen_capture.get_statistics()
        logger.info(f"截图次数: {ss_stats['capture_count']}")
        logger.info(f"上传次数: {ss_stats['upload_count']}")
        logger.info(f"被拦截次数: {ss_stats['blocked_count']}")

        # 输入监控统计
        input_stats = self.input_monitor.get_status()
        logger.info(f"系统总空闲时间: {input_stats['total_idle_time']:.1f}s")
        logger.info(f"空闲次数: {input_stats['idle_count']}")

        # 热力图统计
        hm_stats = self.heatmap_collector.get_switch_frequency_summary()
        logger.info(f"热力图总切换: {hm_stats['total_switches']}")
        logger.info(f"追踪应用数: {hm_stats['total_apps']}")

        # 任务栏统计
        tb_stats = self.taskbar_monitor.get_statistics()
        logger.info(f"任务栏报告次数: {tb_stats['report_count']}")

        logger.info("=" * 60)


def main():
    """程序入口"""
    try:
        app = StalkerTrayApp()
        app.run()
    except Exception as e:
        logger.critical(f"应用程序启动失败: {e}", exc_info=True)
        try:
            import tkinter.messagebox as mb
            mb.showerror("视奸面板 - 启动失败", f"应用程序启动失败:\n{e}")
        except Exception:
            pass
        sys.exit(1)


if __name__ == '__main__':
    main()
