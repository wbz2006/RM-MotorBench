package com.rm.motorbench;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkRequest;
import android.net.wifi.WifiNetworkSpecifier;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.Log;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebChromeClient;

import androidx.webkit.WebViewAssetLoader;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final int NEARBY_WIFI_PERMISSION = 41;
    private static final String DEFAULT_HOST = "192.168.4.1";
    private static final int DEFAULT_PORT = 7000;
    private static final byte[] BRIDGE_HELLO = {0x4d, 0x42, 0x57, 0x31};
    private static final byte[] BRIDGE_READY = {0x4d, 0x42, 0x4f, 0x4b};
    private static final byte[] ALL_STOP = {(byte) 0xa5, 0x05, 0x00, 0x77, 0x5a};

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService tcpExecutor = Executors.newSingleThreadExecutor();
    private final ExecutorService writeExecutor = Executors.newSingleThreadExecutor();
    private final Object socketLock = new Object();
    private WebView webView;
    private ConnectivityManager connectivity;
    private ConnectivityManager.NetworkCallback wifiCallback;
    private volatile Network wifiNetwork;
    private volatile Socket socket;
    private volatile OutputStream socketOutput;
    private volatile boolean wantsTcp;
    private volatile boolean tcpLoopRunning;
    private volatile boolean foreground;
    private volatile boolean destroyed;
    private String host = DEFAULT_HOST;
    private int port = DEFAULT_PORT;

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(android.graphics.Color.rgb(16, 18, 17));
        getWindow().setNavigationBarColor(android.graphics.Color.rgb(16, 18, 17));
        getWindow().getDecorView().setSystemUiVisibility(0);
        connectivity = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);

        webView = new WebView(this);
        webView.setBackgroundColor(android.graphics.Color.rgb(16, 18, 17));
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setVerticalScrollBarEnabled(false);
        webView.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets.consumeSystemWindowInsets();
        });
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.getSettings().setAllowFileAccess(false);
        webView.getSettings().setAllowContentAccess(false);
        webView.addJavascriptInterface(new AndroidLink(), "MotorBenchAndroid");
        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            private final WebViewAssetLoader assets = new WebViewAssetLoader.Builder()
                    .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(MainActivity.this))
                    .build();

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assets.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return true;
            }
        });
        setContentView(webView);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        webView.loadUrl("https://appassets.androidplatform.net/assets/www/index.html");
    }

    @Override
    protected void onStart() {
        super.onStart();
        foreground = true;
        if (wantsTcp) {
            if (wifiNetwork != null) startTcpLoop();
            else requestWifiNetwork();
        }
    }

    @Override
    protected void onPause() {
        sendAllStop();
        if (webView != null) {
            webView.evaluateJavascript("window.__motorBenchAndroidPause?.()", null);
        }
        super.onPause();
    }

    @Override
    protected void onStop() {
        foreground = false;
        writeExecutor.execute(this::closeCurrentSocket);
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        destroyed = true;
        sendAllStop();
        wantsTcp = false;
        writeExecutor.execute(this::closeCurrentSocket);
        if (wifiCallback != null) {
            connectivity.unregisterNetworkCallback(wifiCallback);
            wifiCallback = null;
        }
        if (webView != null) {
            webView.removeJavascriptInterface("MotorBenchAndroid");
            webView.destroy();
            webView = null;
        }
        tcpExecutor.shutdownNow();
        writeExecutor.shutdown();
        super.onDestroy();
    }

    private final class AndroidLink {
        @JavascriptInterface
        public void connectWifi(String targetHost, int targetPort) {
            if (targetHost == null || !targetHost.matches("[a-zA-Z0-9.]+") || targetPort < 1 || targetPort > 65535) {
                dispatchWifiState("ESP32 地址或端口无效");
                return;
            }
            host = targetHost;
            port = targetPort;
            wantsTcp = true;
            if (wifiNetwork != null) {
                startTcpLoop();
                return;
            }
            requestWifiNetwork();
        }

        @JavascriptInterface
        public void sendBytes(String base64) {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            writeExecutor.execute(() -> writeBytes(bytes));
        }

        @JavascriptInterface
        public void closeTcp() {
            wantsTcp = false;
            writeExecutor.execute(MainActivity.this::closeCurrentSocket);
            dispatchWifiState("TCP 已断开");
        }
    }

    private void writeBytes(byte[] bytes) {
        synchronized (socketLock) {
            if (socketOutput == null || socket == null || socket.isClosed()) return;
            try {
                socketOutput.write(bytes);
                socketOutput.flush();
            } catch (IOException error) {
                Log.w("MotorBench", "TCP write failed", error);
                closeCurrentSocket();
            }
        }
    }

    private void requestWifiNetwork() {
        main.post(() -> {
            if (!foreground || destroyed || !wantsTcp) return;
            String permission = Build.VERSION.SDK_INT >= 33
                    ? Manifest.permission.NEARBY_WIFI_DEVICES : Manifest.permission.ACCESS_FINE_LOCATION;
            if (checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(Build.VERSION.SDK_INT >= 33 ? new String[]{permission}
                        : new String[]{permission, Manifest.permission.ACCESS_COARSE_LOCATION}, NEARBY_WIFI_PERMISSION);
                return;
            }
            if (wifiCallback != null) return;
            dispatchWifiState("正在请求连接 RM-MotorBench-ESP32…");
            WifiNetworkSpecifier specifier = new WifiNetworkSpecifier.Builder()
                    .setSsid("RM-MotorBench-ESP32")
                    .setWpa2Passphrase("motorbench")
                    .build();
            NetworkRequest request = new NetworkRequest.Builder()
                    .addTransportType(android.net.NetworkCapabilities.TRANSPORT_WIFI)
                    .removeCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    .setNetworkSpecifier(specifier)
                    .build();
            wifiCallback = new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(Network network) {
                    wifiNetwork = network;
                    dispatchWifiState("已连接 ESP32 热点，正在连接控制板…");
                    if (wantsTcp) startTcpLoop();
                }

                @Override
                public void onLost(Network network) {
                    if (!network.equals(wifiNetwork)) return;
                    wifiNetwork = null;
                    closeCurrentSocket();
                    dispatchWifiState("ESP32 热点已断开，正在重新连接…");
                    connectivity.unregisterNetworkCallback(this);
                    wifiCallback = null;
                    main.postDelayed(() -> { if (wantsTcp) requestWifiNetwork(); }, 1200);
                }

                @Override
                public void onUnavailable() {
                    wifiCallback = null;
                    dispatchWifiState("未能连接 ESP32 热点，请确认设备已上电、Wi-Fi 已开启后重试；Android 10–12 还需开启定位");
                }
            };
            try {
                connectivity.requestNetwork(request, wifiCallback, main, 30000);
            } catch (SecurityException error) {
                wifiCallback = null;
                dispatchWifiState("Android 未授予附近 Wi-Fi 权限");
            }
        });
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != NEARBY_WIFI_PERMISSION) return;
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            requestWifiNetwork();
        } else {
            dispatchWifiState("需要允许 Wi-Fi 连接权限（Android 10–12 为定位权限），授权后点击重试连接");
        }
    }

    private void startTcpLoop() {
        synchronized (socketLock) {
            if (tcpLoopRunning || !wantsTcp || !foreground || destroyed) return;
            tcpLoopRunning = true;
        }
        tcpExecutor.execute(this::runTcpLoop);
    }

    private void runTcpLoop() {
        boolean openedBefore = false;
        try {
            while (wantsTcp && foreground && !destroyed) {
                Network network = wifiNetwork;
                if (network == null) {
                    sleep(250);
                    continue;
                }
                Socket candidate = null;
                boolean opened = false;
                try {
                    candidate = network.getSocketFactory().createSocket();
                    synchronized (socketLock) { socket = candidate; }
                    candidate.connect(new InetSocketAddress(host, port), 5000);
                    candidate.setSoTimeout(3000);
                    candidate.setTcpNoDelay(true);
                    candidate.setKeepAlive(true);
                    InputStream input = candidate.getInputStream();
                    OutputStream output = candidate.getOutputStream();
                    output.write(BRIDGE_HELLO);
                    output.flush();
                    byte[] response = readExact(input, BRIDGE_READY.length);
                    if (!java.util.Arrays.equals(response, BRIDGE_READY)) throw new IOException("ESP32 握手响应无效");
                    candidate.setSoTimeout(0);
                    synchronized (socketLock) {
                        socket = candidate;
                        socketOutput = output;
                    }
                    opened = true;
                    openedBefore = true;
                    dispatchWifiState("ESP32-S3 已连接 · 等待控制板应答");
                    dispatch("window.__motorBenchAndroidOpened(" + quote("TCP://" + host + ":" + port) + ")");
                    byte[] buffer = new byte[4096];
                    int count;
                    while (wantsTcp && foreground && !candidate.isClosed() && (count = input.read(buffer)) >= 0) {
                        if (count == 0) continue;
                        byte[] received = java.util.Arrays.copyOf(buffer, count);
                        dispatch("window.__motorBenchAndroidData(" + quote(Base64.encodeToString(received, Base64.NO_WRAP)) + ")");
                    }
                    if (wantsTcp) throw new IOException("ESP32 TCP 连接已关闭");
                } catch (IOException error) {
                    Log.i("MotorBench", "TCP connection ended: " + error.getMessage());
                    if (wantsTcp) dispatchWifiState(openedBefore
                            ? "连接中断，正在自动重连…"
                            : "ESP32 TCP 连接失败，正在重试…");
                } finally {
                    if (candidate != null) {
                        synchronized (socketLock) {
                            if (socket == candidate) {
                                socket = null;
                                socketOutput = null;
                            }
                        }
                        try {
                            candidate.close();
                        } catch (IOException error) {
                            Log.w("MotorBench", "TCP cleanup failed", error);
                        }
                    }
                    if (opened) dispatch("window.__motorBenchAndroidClosed('连接中断')");
                }
                if (wantsTcp) sleep(600);
            }
        } finally {
            synchronized (socketLock) {
                tcpLoopRunning = false;
            }
            if (wantsTcp && foreground && !destroyed) main.post(this::startTcpLoop);
        }
    }

    private static byte[] readExact(InputStream input, int length) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(length);
        byte[] buffer = new byte[length];
        while (bytes.size() < length) {
            int count = input.read(buffer, 0, length - bytes.size());
            if (count < 0) throw new IOException("ESP32 在握手前关闭连接");
            bytes.write(buffer, 0, count);
        }
        return bytes.toByteArray();
    }

    private void sendAllStop() {
        writeExecutor.execute(() -> writeBytes(ALL_STOP));
    }

    private void closeCurrentSocket() {
        synchronized (socketLock) {
            Socket current = socket;
            socket = null;
            socketOutput = null;
            if (current != null) {
                try {
                    current.close();
                } catch (IOException error) {
                    Log.w("MotorBench", "TCP close failed", error);
                }
            }
        }
    }

    private void dispatchWifiState(String message) {
        dispatch("window.__motorBenchAndroidWifiState(" + quote(message) + ")");
    }

    private void dispatch(String script) {
        main.post(() -> {
            if (webView != null) webView.evaluateJavascript(script, null);
        });
    }

    private static String quote(String value) {
        return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\n", "\\n").replace("\r", "\\r") + "\"";
    }

    private static void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
        }
    }
}
