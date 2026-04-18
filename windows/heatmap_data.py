#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
heatmap_data.py - 窗口切换频率热力图模块
记录每次窗口切换事件，按时间段（每小时）聚合窗口切换频率，
生成热力图数据并发送到服务器。
"""

import logging
import threading
import time
from typing import Optional, Dict, Any, List, Callable
from collections import defaultdict
from datetime import datetime, timedelta

logger = logging.getLogger(__name__)


class HeatmapRecord:
    """单条窗口切换记录"""

    def __init__(self, window_title: str, process_name: str,
                 class_name: str = "", exe_path: str = "",
                 timestamp: Optional[float] = None):
        self.window_title = window_title
        self.process_name = process_name
        self.class_name = class_name
        self.exe_path = exe_path
        self.timestamp = timestamp or time.time()

    def to_dict(self) -> Dict[str, Any]:
        """转换为字典"""
        return {
            "window_title": self.window_title,
            "process_name": self.process_name,
            "class_name": self.class_name,
            "exe_path": self.exe_path,
            "timestamp": self.timestamp
        }


class HeatmapDataCollector:
    """窗口切换频率热力图数据收集器"""

    # 聚合粒度：每 N 分钟一个时间段
    DEFAULT_BUCKET_SIZE = 60  # 60分钟 = 1小时

    def __init__(self, api_client=None, bucket_size: int = DEFAULT_BUCKET_SIZE,
                 max_records: int = 10000, report_interval: float = 300.0):
        """
        初始化热力图数据收集器
        :param api_client: API 客户端实例
        :param bucket_size: 时间桶大小（分钟），用于聚合
        :param max_records: 最大保留记录数
        :param report_interval: 定期报告间隔（秒）
        """
        self.api_client = api_client
        self.bucket_size = bucket_size  # 分钟
        self.max_records = max_records
        self.report_interval = report_interval

        # 原始记录列表（按时间排序）
        self._records: List[HeatmapRecord] = []
        self._lock = threading.Lock()

        # 聚合数据
        # 按小时统计切换频率: { "YYYY-MM-DD HH:00": count }
        self._hourly_frequency: Dict[str, int] = defaultdict(int)
        # 按应用统计使用时间: { "process_name": total_seconds }
        self._app_usage_time: Dict[str, float] = defaultdict(float)
        # 按应用统计切换次数: { "process_name": switch_count }
        self._app_switch_count: Dict[str, int] = defaultdict(int)
        # 当前应用开始时间
        self._current_app_start: Optional[float] = None
        self._current_app_name: Optional[str] = None

        # 定期报告线程
        self._report_thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._running = False

        # 回调
        self._on_switch_callbacks: List[Callable] = []

        logger.info(
            f"热力图数据收集器初始化完成 - "
            f"时间桶: {bucket_size}分钟, "
            f"最大记录: {max_records}, "
            f"报告间隔: {report_interval}s"
        )

    def on_switch(self, callback: Callable):
        """注册窗口切换回调"""
        self._on_switch_callbacks.append(callback)

    def start(self):
        """启动热力图数据收集"""
        if self._running:
            logger.warning("热力图收集已在运行")
            return True

        self._stop_event.clear()
        self._running = True
        self._current_app_start = time.time()

        # 启动定期报告线程
        self._report_thread = threading.Thread(
            target=self._report_loop,
            name="HeatmapReport",
            daemon=True
        )
        self._report_thread.start()
        logger.info("热力图数据收集已启动")
        return True

    def stop(self):
        """停止热力图数据收集"""
        self._stop_event.set()
        self._running = False

        if self._report_thread and self._report_thread.is_alive():
            self._report_thread.join(timeout=10)

        logger.info("热力图数据收集已停止")

    def _report_loop(self):
        """定期报告主循环"""
        logger.info("热力图定期报告线程已启动")

        while not self._stop_event.is_set():
            try:
                # 更新当前应用使用时间
                self._update_current_app_usage()

                # 发送聚合数据
                self._report_aggregated_data()
            except Exception as e:
                logger.error(f"热力图报告出错: {e}")

            self._stop_event.wait(self.report_interval)

        logger.info("热力图定期报告线程已退出")

    def record_switch(self, window_title: str, process_name: str,
                      class_name: str = "", exe_path: str = ""):
        """
        记录一次窗口切换事件
        :param window_title: 窗口标题
        :param process_name: 进程名
        :param class_name: 窗口类名
        :param exe_path: 可执行路径
        """
        now = time.time()

        # 更新当前应用使用时间
        self._update_current_app_usage()

        with self._lock:
            # 创建记录
            record = HeatmapRecord(
                window_title=window_title,
                process_name=process_name,
                class_name=class_name,
                exe_path=exe_path,
                timestamp=now
            )
            self._records.append(record)

            # 限制记录数量
            if len(self._records) > self.max_records:
                # 保留最新的记录，丢弃旧的
                removed = self._records[:len(self._records) - self.max_records]
                self._records = self._records[-self.max_records:]
                logger.debug(f"热力图记录已裁剪，丢弃 {len(removed)} 条旧记录")

            # 更新小时频率
            hour_key = self._get_hour_key(now)
            self._hourly_frequency[hour_key] += 1

            # 更新应用切换计数
            app_key = exe_path or process_name
            self._app_switch_count[app_key] += 1

            # 更新当前应用
            self._current_app_name = app_key
            self._current_app_start = now

        # 通知回调
        for cb in self._on_switch_callbacks:
            try:
                cb(record)
            except Exception as e:
                logger.error(f"窗口切换回调执行失败: {e}")

    def _update_current_app_usage(self):
        """更新当前应用的使用时间统计"""
        with self._lock:
            if self._current_app_start and self._current_app_name:
                duration = time.time() - self._current_app_start
                self._app_usage_time[self._current_app_name] += duration
                self._current_app_start = time.time()

    def _get_hour_key(self, timestamp: float) -> str:
        """
        获取时间戳对应的小时键
        :param timestamp: Unix 时间戳
        :return: 格式化的小时键 "YYYY-MM-DD HH:00"
        """
        dt = datetime.fromtimestamp(timestamp)
        return dt.strftime("%Y-%m-%d %H:00")

    def _report_aggregated_data(self):
        """向服务器报告聚合数据"""
        if not self.api_client:
            return

        with self._lock:
            # 准备小时频率数据
            hourly_data = dict(self._hourly_frequency)

            # 准备应用使用时间数据
            app_usage = {
                k: round(v, 1) for k, v in self._app_usage_time.items()
            }

            # 准备应用切换计数
            app_switches = dict(self._app_switch_count)

        # 只在有数据时才发送
        if not hourly_data:
            return

        # 构建热力图数据
        data = {
            "hourly_switch_frequency": hourly_data,
            "app_usage_time_seconds": app_usage,
            "app_switch_counts": app_switches,
            "total_switches": sum(hourly_data.values()),
            "bucket_size_minutes": self.bucket_size,
            "data_range": {
                "start": self._get_hour_key(min(r.timestamp for r in self._records)) if self._records else None,
                "end": self._get_hour_key(max(r.timestamp for r in self._records)) if self._records else None
            }
        }

        try:
            self.api_client.send_heatmap_data(data)
            logger.debug(f"热力图数据已报告 - 总切换: {data['total_switches']}")
        except Exception as e:
            logger.error(f"发送热力图数据失败: {e}")

    def get_hourly_frequency(self, hours: int = 24) -> Dict[str, int]:
        """
        获取最近 N 小时的窗口切换频率
        :param hours: 小时数
        :return: 按小时分组的切换频率字典
        """
        cutoff = time.time() - hours * 3600
        result = {}

        with self._lock:
            for key, count in self._hourly_frequency.items():
                # 解析时间键
                try:
                    dt = datetime.strptime(key, "%Y-%m-%d %H:00")
                    if dt.timestamp() >= cutoff:
                        result[key] = count
                except ValueError:
                    continue

        return result

    def get_app_ranking(self, top_n: int = 10) -> List[Dict[str, Any]]:
        """
        获取使用时间排名前 N 的应用
        :param top_n: 返回数量
        :return: 排名列表
        """
        with self._lock:
            # 更新当前应用使用时间
            if self._current_app_start and self._current_app_name:
                duration = time.time() - self._current_app_start
                current_usage = dict(self._app_usage_time)
                current_usage[self._current_app_name] += duration
            else:
                current_usage = dict(self._app_usage_time)

            # 按使用时间排序
            sorted_apps = sorted(
                current_usage.items(),
                key=lambda x: x[1],
                reverse=True
            )

        ranking = []
        for i, (app, usage) in enumerate(sorted_apps[:top_n]):
            ranking.append({
                "rank": i + 1,
                "app": app,
                "usage_seconds": round(usage, 1),
                "usage_minutes": round(usage / 60, 1),
                "switches": self._app_switch_count.get(app, 0)
            })

        return ranking

    def get_switch_frequency_summary(self) -> Dict[str, Any]:
        """
        获取窗口切换频率摘要
        :return: 摘要数据
        """
        with self._lock:
            total = sum(self._hourly_frequency.values())
            avg_per_hour = 0.0
            if self._hourly_frequency:
                avg_per_hour = total / max(len(self._hourly_frequency), 1)

            # 计算最高频的小时
            peak_hour = ""
            peak_count = 0
            for key, count in self._hourly_frequency.items():
                if count > peak_count:
                    peak_count = count
                    peak_hour = key

        return {
            "total_switches": total,
            "avg_per_hour": round(avg_per_hour, 1),
            "peak_hour": peak_hour,
            "peak_count": peak_count,
            "total_tracked_hours": len(self._hourly_frequency),
            "total_records": len(self._records),
            "total_apps": len(self._app_usage_time)
        }

    def get_today_heatmap(self) -> Dict[str, int]:
        """
        获取今日的热力图数据（按小时）
        :return: 今日每小时切换次数
        """
        today = datetime.now().strftime("%Y-%m-%d")
        result = {}

        with self._lock:
            for key, count in self._hourly_frequency.items():
                if key.startswith(today):
                    result[key] = count

        return result

    def clear_data(self):
        """清除所有收集的数据"""
        with self._lock:
            self._records.clear()
            self._hourly_frequency.clear()
            self._app_usage_time.clear()
            self._app_switch_count.clear()
            self._current_app_start = time.time()
            self._current_app_name = None

        logger.info("热力图数据已清除")

    def get_statistics(self) -> Dict[str, Any]:
        """获取收集器统计信息"""
        return {
            "total_records": len(self._records),
            "total_switches": sum(self._hourly_frequency.values()),
            "total_apps": len(self._app_usage_time),
            "tracked_hours": len(self._hourly_frequency),
            "bucket_size_minutes": self.bucket_size
        }

    def shutdown(self):
        """关闭热力图数据收集器"""
        self.stop()
        logger.info("热力图数据收集器已关闭")
