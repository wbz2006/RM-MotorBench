# MotorBench Android

The Android app opens the existing MotorBench control panel locally. It starts on the ESP32 connection page, requests the `RM-MotorBench-ESP32` Wi-Fi network, and enables the control page after the board replies.

On first use Android asks for Nearby devices permission (location permission on Android 10–12) and confirmation to join the ESP32 hotspot. Android 10–12 also requires the system location switch to be on. Android controls the network confirmation dialog; some phones may show it again on a later connection. The app requests the hotspot on launch and reconnects after a lost connection. If Android cancels the request or the hotspot is unavailable, power on the device and tap Retry.

The app uses the ESP32 TCP bridge at `192.168.4.1:7000`; USB serial is not available on this mobile build. The first screen shows the connection state. A board heartbeat opens the second screen; the bottom tabs let you return to the connection screen. Losing the connection returns to the first screen. Backgrounding the app sends all-stop, ends automatic output and closes TCP when the activity stops; returning reconnects without automatically enabling motors. Keep the app open in the foreground while controlling motors.

## Build

Open this directory in Android Studio, or build a debug APK with Gradle:

```powershell
.\gradlew.bat assembleDebug
```

Use JDK 17 or newer and an Android SDK with API 36. Set `ANDROID_HOME` to the SDK directory or configure `sdk.dir` in local.properties. The APK is written to `app/build/outputs/apk/debug/app-debug.apk`. The Gradle build copies the current web control panel from `../motor_bench_host`, so the APK includes the same controls and protocol implementation. The UI is bundled locally and Android provides the TCP connection; the phone does not run Node or require an Internet connection.

Minimum Android version: Android 10 (API 29).
