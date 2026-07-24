# InkOS PaperS3 固件 / Firmware

版本：`1.0.0`

目标：M5Stack PaperS3 / ESP32-S3 / 16 MiB Flash

构建环境：ESP-IDF 5.4.3、esptool 4.11.0

## 选择哪个文件

| 文件 | 写入地址 | 用途 |
| --- | ---: | --- |
| `inkos-papers3-1.0.0-factory.bin` | `0x0` | 完整首次安装或恢复系统固件，包含 bootloader、分区表和应用；会重置 NVS 中的设备配置与当前首页选择，不擦除镜像覆盖范围以外的首页 A/B 分区 |
| `inkos-papers3-1.0.0-app.bin` | `0x20000` | 仅升级应用，要求设备已使用相同分区表；保留 Wi-Fi、内容列表和已安装首页 |

首次安装：

```bash
python -m esptool \
  --chip esp32s3 \
  --port /dev/your-papers3-port \
  --baud 460800 \
  --before default_reset \
  --after hard_reset \
  write_flash \
  --flash_mode dio \
  --flash_freq 80m \
  --flash_size 16MB \
  0x0 inkos-papers3-1.0.0-factory.bin
```

仅升级应用：

```bash
python -m esptool \
  --chip esp32s3 \
  --port /dev/your-papers3-port \
  --baud 460800 \
  --before default_reset \
  --after hard_reset \
  write_flash \
  --flash_mode dio \
  --flash_freq 80m \
  --flash_size 16MB \
  0x20000 inkos-papers3-1.0.0-app.bin
```

烧录前可以校验：

```bash
shasum -a 256 -c SHA256SUMS
```

## English

Use the `factory` image at offset `0x0` for a complete first installation or
system-firmware recovery. It contains the bootloader, partition table, and
application, and resets device configuration and the active-home selection
stored in NVS. It does not erase the home A/B partitions beyond the merged
image range.

Use the `app` image at offset `0x20000` only when the device already has the
same InkOS partition table. An app-only update preserves Wi-Fi credentials,
content collections, and the installed home package.

Verify both binaries with `shasum -a 256 -c SHA256SUMS` before flashing.
