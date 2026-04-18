#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
settings_dialog.py - 设置对话框模块
使用 tkinter 构建设置界面，支持服务器地址、设备名称、各项间隔和质量配置。
支持从 config.json 加载/保存设置，以及 Windows 开机自启动注册。
"""

import os
import json
import logging
import platform
from typing import Optional, Dict, Any, Callable

logger = logging.getLogger(__name__)

# 尝试导入 tkinter
try:
    import tkinter as tk
    from tkinter import ttk, messagebox
    TKINTER_AVAILABLE = True
except ImportError:
    TKINTER_AVAILABLE = False
    logger.warning("tkinter 不可用，设置对话框将被禁用")


class SettingsDialog:
    """设置对话框"""

    # 默认配置
    DEFAULT_CONFIG = {
        "server_url": "http://localhost:3000",
        "device_name": "MyWindowsPC",
        "heartbeat_interval": 30,
        "upload_interval": 5,
        "screenshot_quality": 80,
        "auto_start": False,
        "poll_interval": 5
    }

    def __init__(self, config_path: str = "config.json",
                 on_save: Optional[Callable[[Dict[str, Any]], None]] = None):
        """
        初始化设置对话框
        :param config_path: 配置文件路径
        :param on_save: 保存回调，参数为配置字典
        """
        self.config_path = config_path
        self.on_save = on_save
        self.config = self._load_config()

        # tkinter 变量（延迟初始化）
        self._root: Optional[tk.Tk] = None
        self._server_url_var: Optional[tk.StringVar] = None
        self._device_name_var: Optional[tk.StringVar] = None
        self._heartbeat_var: Optional[tk.IntVar] = None
        self._upload_var: Optional[tk.IntVar] = None
        self._quality_var: Optional[tk.IntVar] = None
        self._poll_var: Optional[tk.IntVar] = None
        self._auto_start_var: Optional[tk.BooleanVar] = None

        logger.info(f"设置对话框初始化完成 - 配置文件: {config_path}")

    def _load_config(self) -> Dict[str, Any]:
        """从文件加载配置"""
        try:
            # 获取脚本所在目录作为配置文件基路径
            script_dir = os.path.dirname(os.path.abspath(__file__))
            config_file = os.path.join(script_dir, self.config_path)

            with open(config_file, 'r', encoding='utf-8') as f:
                config = json.load(f)

            # 合并默认值（确保所有字段存在）
            for key, value in self.DEFAULT_CONFIG.items():
                if key not in config:
                    config[key] = value

            logger.info(f"配置已从 {config_file} 加载")
            return config

        except FileNotFoundError:
            logger.warning("配置文件不存在，使用默认配置")
            return dict(self.DEFAULT_CONFIG)
        except (json.JSONDecodeError, IOError) as e:
            logger.error(f"配置文件读取失败: {e}，使用默认配置")
            return dict(self.DEFAULT_CONFIG)

    def _save_config(self, config: Dict[str, Any]) -> bool:
        """保存配置到文件"""
        try:
            script_dir = os.path.dirname(os.path.abspath(__file__))
            config_file = os.path.join(script_dir, self.config_path)

            with open(config_file, 'w', encoding='utf-8') as f:
                json.dump(config, f, ensure_ascii=False, indent=2)

            logger.info(f"配置已保存到 {config_file}")
            return True

        except IOError as e:
            logger.error(f"配置文件保存失败: {e}")
            return False

    def get_config(self) -> Dict[str, Any]:
        """获取当前配置"""
        return dict(self.config)

    def update_config(self, new_config: Dict[str, Any]):
        """更新配置（不弹窗）"""
        self.config.update(new_config)
        self._save_config(self.config)

    def show(self):
        """显示设置对话框"""
        if not TKINTER_AVAILABLE:
            logger.error("tkinter 不可用，无法显示设置对话框")
            return

        # 创建主窗口
        self._root = tk.Tk()
        self._root.title("视奸面板 - 设置")
        self._root.geometry("480x520")
        self._root.resizable(False, False)

        # 设置窗口图标（如果有的话）
        try:
            self._root.iconbitmap(default='')
        except Exception:
            pass

        # 居中显示
        self._center_window()

        # 创建界面
        self._create_widgets()

        # 加载当前配置到界面
        self._load_to_ui()

        # 绑定关闭事件
        self._root.protocol("WM_DELETE_WINDOW", self._on_close)

        # 进入主循环（阻塞）
        self._root.mainloop()

    def _center_window(self):
        """将窗口居中显示"""
        try:
            self._root.update_idletasks()
            width = self._root.winfo_width()
            height = self._root.winfo_height()
            x = (self._root.winfo_screenwidth() // 2) - (width // 2)
            y = (self._root.winfo_screenheight() // 2) - (height // 2)
            self._root.geometry(f'+{x}+{y}')
        except Exception:
            pass

    def _create_widgets(self):
        """创建界面控件"""
        # 主框架
        main_frame = ttk.Frame(self._root, padding="15")
        main_frame.pack(fill=tk.BOTH, expand=True)

        # 标题
        title_label = ttk.Label(
            main_frame, text="⚙ 视奸面板客户端设置",
            font=("Microsoft YaHei UI", 14, "bold")
        )
        title_label.pack(pady=(0, 15))

        # === 服务器设置 ===
        server_frame = ttk.LabelFrame(main_frame, text="服务器设置", padding="10")
        server_frame.pack(fill=tk.X, pady=(0, 10))

        # 服务器地址
        ttk.Label(server_frame, text="服务器地址:").grid(row=0, column=0, sticky=tk.W, pady=3)
        self._server_url_var = tk.StringVar()
        server_entry = ttk.Entry(server_frame, textvariable=self._server_url_var, width=35)
        server_entry.grid(row=0, column=1, sticky=tk.EW, pady=3, padx=(5, 0))
        ttk.Label(server_frame, text="(例: http://192.168.1.100:3000)",
                  foreground="gray").grid(row=1, column=0, columnspan=2, sticky=tk.W)

        # 设备名称
        ttk.Label(server_frame, text="设备名称:").grid(row=2, column=0, sticky=tk.W, pady=3)
        self._device_name_var = tk.StringVar()
        device_entry = ttk.Entry(server_frame, textvariable=self._device_name_var, width=35)
        device_entry.grid(row=2, column=1, sticky=tk.EW, pady=3, padx=(5, 0))

        server_frame.columnconfigure(1, weight=1)

        # === 间隔设置 ===
        interval_frame = ttk.LabelFrame(main_frame, text="间隔设置", padding="10")
        interval_frame.pack(fill=tk.X, pady=(0, 10))

        # 心跳间隔
        ttk.Label(interval_frame, text="心跳间隔 (秒):").grid(row=0, column=0, sticky=tk.W, pady=3)
        self._heartbeat_var = tk.IntVar(value=30)
        heartbeat_scale = ttk.Scale(
            interval_frame, from_=10, to=120,
            variable=self._heartbeat_var, orient=tk.HORIZONTAL,
            command=lambda v: self._update_label(heartbeat_label, v)
        )
        heartbeat_scale.grid(row=0, column=1, sticky=tk.EW, pady=3, padx=(5, 0))
        heartbeat_label = ttk.Label(interval_frame, text="30 秒", width=8)
        heartbeat_label.grid(row=0, column=2, padx=(5, 0))

        # 上传间隔
        ttk.Label(interval_frame, text="上传间隔 (秒):").grid(row=1, column=0, sticky=tk.W, pady=3)
        self._upload_var = tk.IntVar(value=5)
        upload_scale = ttk.Scale(
            interval_frame, from_=1, to=60,
            variable=self._upload_var, orient=tk.HORIZONTAL,
            command=lambda v: self._update_label(upload_label, v)
        )
        upload_scale.grid(row=1, column=1, sticky=tk.EW, pady=3, padx=(5, 0))
        upload_label = ttk.Label(interval_frame, text="5 秒", width=8)
        upload_label.grid(row=1, column=2, padx=(5, 0))

        # 轮询间隔
        ttk.Label(interval_frame, text="命令轮询 (秒):").grid(row=2, column=0, sticky=tk.W, pady=3)
        self._poll_var = tk.IntVar(value=5)
        poll_scale = ttk.Scale(
            interval_frame, from_=1, to=30,
            variable=self._poll_var, orient=tk.HORIZONTAL,
            command=lambda v: self._update_label(poll_label, v)
        )
        poll_scale.grid(row=2, column=1, sticky=tk.EW, pady=3, padx=(5, 0))
        poll_label = ttk.Label(interval_frame, text="5 秒", width=8)
        poll_label.grid(row=2, column=2, padx=(5, 0))

        interval_frame.columnconfigure(1, weight=1)

        # === 截图设置 ===
        quality_frame = ttk.LabelFrame(main_frame, text="截图设置", padding="10")
        quality_frame.pack(fill=tk.X, pady=(0, 10))

        ttk.Label(quality_frame, text="截图质量:").grid(row=0, column=0, sticky=tk.W, pady=3)
        self._quality_var = tk.IntVar(value=80)
        quality_scale = ttk.Scale(
            quality_frame, from_=10, to=100,
            variable=self._quality_var, orient=tk.HORIZONTAL,
            command=lambda v: self._update_label(quality_label, v, suffix="%")
        )
        quality_scale.grid(row=0, column=1, sticky=tk.EW, pady=3, padx=(5, 0))
        quality_label = ttk.Label(quality_frame, text="80%", width=8)
        quality_label.grid(row=0, column=2, padx=(5, 0))

        quality_frame.columnconfigure(1, weight=1)

        # === 启动设置 ===
        startup_frame = ttk.LabelFrame(main_frame, text="启动设置", padding="10")
        startup_frame.pack(fill=tk.X, pady=(0, 10))

        self._auto_start_var = tk.BooleanVar(value=False)
        auto_start_check = ttk.Checkbutton(
            startup_frame, text="开机自动启动",
            variable=self._auto_start_var,
            command=self._on_auto_start_toggle
        )
        auto_start_check.pack(anchor=tk.W)

        # === 按钮 ===
        button_frame = ttk.Frame(main_frame)
        button_frame.pack(fill=tk.X, pady=(10, 0))

        save_btn = ttk.Button(button_frame, text="保存", command=self._on_save)
        save_btn.pack(side=tk.RIGHT, padx=(5, 0))

        cancel_btn = ttk.Button(button_frame, text="取消", command=self._on_close)
        cancel_btn.pack(side=tk.RIGHT)

        # 连接测试按钮
        test_btn = ttk.Button(button_frame, text="测试连接", command=self._test_connection)
        test_btn.pack(side=tk.LEFT)

    def _update_label(self, label: ttk.Label, value: str, suffix: str = " 秒"):
        """更新滑块标签"""
        try:
            int_val = int(float(value))
            label.config(text=f"{int_val}{suffix}")
        except (ValueError, TypeError):
            pass

    def _load_to_ui(self):
        """加载当前配置到界面"""
        if not self._root:
            return

        try:
            self._server_url_var.set(self.config.get('server_url', ''))
            self._device_name_var.set(self.config.get('device_name', ''))
            self._heartbeat_var.set(self.config.get('heartbeat_interval', 30))
            self._upload_var.set(self.config.get('upload_interval', 5))
            self._quality_var.set(self.config.get('screenshot_quality', 80))
            self._poll_var.set(self.config.get('poll_interval', 5))
            self._auto_start_var.set(self.config.get('auto_start', False))
        except Exception as e:
            logger.error(f"加载配置到界面失败: {e}")

    def _on_save(self):
        """保存按钮点击"""
        new_config = {
            "server_url": self._server_url_var.get().strip(),
            "device_name": self._device_name_var.get().strip(),
            "heartbeat_interval": self._heartbeat_var.get(),
            "upload_interval": self._upload_var.get(),
            "screenshot_quality": self._quality_var.get(),
            "auto_start": self._auto_start_var.get(),
            "poll_interval": self._poll_var.get()
        }

        # 验证
        if not new_config['server_url']:
            messagebox.showerror("错误", "服务器地址不能为空")
            return

        if not new_config['device_name']:
            messagebox.showerror("错误", "设备名称不能为空")
            return

        # 保存到文件
        self.config.update(new_config)
        success = self._save_config(self.config)

        if success:
            # 调用回调通知配置更新
            if self.on_save:
                try:
                    self.on_save(new_config)
                except Exception as e:
                    logger.error(f"配置保存回调执行失败: {e}")

            messagebox.showinfo("成功", "设置已保存")
            self._root.destroy()
        else:
            messagebox.showerror("错误", "设置保存失败，请检查文件权限")

    def _on_close(self):
        """关闭/取消按钮"""
        self._root.destroy()

    def _test_connection(self):
        """测试服务器连接"""
        url = self._server_url_var.get().strip()
        if not url:
            messagebox.showerror("错误", "请先输入服务器地址")
            return

        try:
            import requests
            test_url = f"{url.rstrip('/')}/api/health"
            response = requests.get(test_url, timeout=5)
            if response.status_code == 200:
                messagebox.showinfo("成功", f"服务器连接正常！\n状态码: {response.status_code}")
            else:
                messagebox.showwarning(
                    "警告",
                    f"服务器已响应，但状态码异常: {response.status_code}\n"
                    f"响应: {response.text[:200]}"
                )
        except requests.exceptions.ConnectionError:
            messagebox.showerror("连接失败", "无法连接到服务器，请检查地址和网络")
        except requests.exceptions.Timeout:
            messagebox.showerror("超时", "连接服务器超时，请检查服务器是否运行")
        except Exception as e:
            messagebox.showerror("错误", f"测试连接失败: {e}")

    def _on_auto_start_toggle(self):
        """开机自启动切换"""
        enabled = self._auto_start_var.get()
        try:
            self._set_auto_start(enabled)
        except Exception as e:
            logger.error(f"设置开机自启动失败: {e}")
            messagebox.showerror("错误", f"设置开机自启动失败: {e}")
            self._auto_start_var.set(not enabled)

    def _set_auto_start(self, enabled: bool):
        """
        设置 Windows 开机自启动
        通过注册表 HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run
        """
        import winreg

        app_name = "StalkerPanel"
        # 获取当前脚本路径
        script_path = os.path.abspath(__file__)
        python_exe = os.path.join(
            os.environ.get('LOCALAPPDATA', ''),
            'Programs', 'Python', 'Python39', 'pythonw.exe'
        )

        # 尝试找到实际的 Python 解释器
        import sys
        python_exe = sys.executable

        # 如果是 python.exe，尝试用 pythonw.exe 替代（无控制台窗口）
        if python_exe.endswith('python.exe'):
            pythonw = python_exe.replace('python.exe', 'pythonw.exe')
            if os.path.exists(pythonw):
                python_exe = pythonw

        # 获取主脚本路径
        main_script = os.path.join(os.path.dirname(script_path), 'stalker_client.py')
        if not os.path.exists(main_script):
            main_script = script_path

        command = f'"{python_exe}" "{main_script}"'

        try:
            key = winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Run",
                0, winreg.KEY_SET_VALUE
            )

            if enabled:
                winreg.SetValueEx(key, app_name, 0, winreg.REG_SZ, command)
                logger.info(f"已设置开机自启动: {command}")
            else:
                try:
                    winreg.DeleteValue(key, app_name)
                    logger.info("已取消开机自启动")
                except FileNotFoundError:
                    pass  # 键不存在，无需删除

            winreg.CloseKey(key)

        except WindowsError as e:
            raise RuntimeError(f"注册表操作失败: {e}")

    @staticmethod
    def is_auto_start_enabled() -> bool:
        """检查是否已设置开机自启动"""
        try:
            import winreg
            key = winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Run",
                0, winreg.KEY_READ
            )
            try:
                value, _ = winreg.QueryValueEx(key, "StalkerPanel")
                winreg.CloseKey(key)
                return bool(value)
            except FileNotFoundError:
                winreg.CloseKey(key)
                return False
        except Exception:
            return False
