package app.aminomon;

import android.app.Activity;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * Hosts the offline web build of Aminomon (assets/www) in a WebView.
 *
 * The game runs Python (Pyodide) in a Web Worker. The game waits for key
 * presses synchronously, and WebView cannot share memory between the page
 * and the worker (no SharedArrayBuffer), so the worker asks this app instead:
 * a synchronous request to https://HOST/__gv/wait is held here until the page
 * pushes an input event through AndroidBridge.push(). Every other request is
 * answered from the APK's assets. Nothing ever touches the network.
 */
public class MainActivity extends Activity {
    private static final String HOST = "appassets.aminomon.local";
    private static final String ORIGIN = "https://" + HOST + "/";
    private WebView web;
    private final LinkedBlockingQueue<String> events = new LinkedBlockingQueue<>();
    private volatile int generation = 0;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(Color.parseColor("#121212")));
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#121212"));
        setContentView(web);
        setup(web);
        web.loadUrl(ORIGIN + "index.html");
        hideSystemBars();
    }

    private void setup(final WebView w) {
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        w.setOverScrollMode(View.OVER_SCROLL_NEVER);
        w.setLongClickable(false);
        w.setOnLongClickListener(v -> true);
        w.addJavascriptInterface(new Object() {
            @JavascriptInterface public void quit() { runOnUiThread(MainActivity.this::finish); }
            @JavascriptInterface public void push(int type, int a, int b, int c) {
                if (events.size() < 600) events.offer(type + "," + a + "," + b + "," + c);
            }
            @JavascriptInterface public void reset(int gen) { generation = gen; events.clear(); }
            @JavascriptInterface public void haptic() {
                runOnUiThread(() -> web.performHapticFeedback(android.view.HapticFeedbackConstants.VIRTUAL_KEY));
            }
            @JavascriptInterface public void shareText(final String text) {
                runOnUiThread(() -> {
                    android.content.Intent i = new android.content.Intent(android.content.Intent.ACTION_SEND);
                    i.setType("text/plain");
                    i.putExtra(android.content.Intent.EXTRA_TEXT, text);
                    startActivity(android.content.Intent.createChooser(i, "Aminomon backup"));
                });
            }
            @JavascriptInterface public void saveImage(final String base64) {
                new Thread(() -> {
                    String msg;
                    try {
                        byte[] data = android.util.Base64.decode(base64, android.util.Base64.DEFAULT);
                        if (Build.VERSION.SDK_INT >= 29) {
                            android.content.ContentValues v = new android.content.ContentValues();
                            v.put(android.provider.MediaStore.Images.Media.DISPLAY_NAME, "aminomon-" + System.currentTimeMillis() + ".png");
                            v.put(android.provider.MediaStore.Images.Media.MIME_TYPE, "image/png");
                            v.put(android.provider.MediaStore.Images.Media.RELATIVE_PATH, "Pictures/Aminomon");
                            android.net.Uri u = getContentResolver().insert(android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v);
                            java.io.OutputStream o = getContentResolver().openOutputStream(u);
                            o.write(data);
                            o.close();
                            msg = "Screenshot saved in Pictures/Aminomon";
                        } else {
                            msg = "Screenshots need Android 10 or newer";
                        }
                    } catch (Exception e) {
                        msg = "Could not save the screenshot";
                    }
                    final String m = msg;
                    runOnUiThread(() -> android.widget.Toast.makeText(MainActivity.this, m, android.widget.Toast.LENGTH_LONG).show());
                }).start();
            }
        }, "AndroidBridge");
        w.setWebChromeClient(new WebChromeClient());
        w.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                if (!r.getUrl().getHost().equals(HOST)) return blocked();   // offline game: no other hosts
                String p = r.getUrl().getPath();
                if (p != null && p.startsWith("/__gv/")) return control(p, r.getUrl());
                return serve(p);
            }
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) { return true; }
            @Override
            public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail d) {
                runOnUiThread(() -> recreate());       // low memory: start again, the save is in localStorage
                return true;
            }
        });
    }

    private WebResourceResponse blocked() {
        return new WebResourceResponse("text/plain", "utf-8", 403, "Blocked", new HashMap<String, String>(), new java.io.ByteArrayInputStream(new byte[0]));
    }

    /** Input channel for the game worker (see the class comment). */
    private WebResourceResponse control(String path, android.net.Uri u) {
        String body = "";
        int ms = 0, g = -1;
        try { ms = Integer.parseInt(u.getQueryParameter("ms")); } catch (Exception e) { /* none */ }
        try { g = Integer.parseInt(u.getQueryParameter("g")); } catch (Exception e) { /* none */ }
        try {
            if (path.equals("/__gv/wait")) {
                if (g == generation) {
                    String s = events.poll(Math.max(0, Math.min(ms, 1000)), TimeUnit.MILLISECONDS);
                    if (s != null) body = s;
                } else {
                    Thread.sleep(50);                       // an old worker: let it run out
                }
            } else if (path.equals("/__gv/sleep")) {
                Thread.sleep(Math.max(0, Math.min(ms, 5000)));
            } else if (path.equals("/__gv/flush")) {
                ArrayList<String> all = new ArrayList<>();
                events.drainTo(all);
                for (String s : all) if (s.startsWith("3,")) { events.clear(); events.offer(s); }  // keep the latest resize
            }
        } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        Map<String, String> h = new HashMap<>();
        h.put("Cache-Control", "no-store");
        return new WebResourceResponse("text/plain", "utf-8", 200, "OK", h, new java.io.ByteArrayInputStream(body.getBytes()));
    }

    private WebResourceResponse serve(String path) {
        if (path == null || path.equals("/") || path.isEmpty()) path = "/index.html";
        path = path.substring(1);
        if (path.contains("..")) return blocked();
        try {
            InputStream in = getAssets().open("www/" + path);
            Map<String, String> h = new HashMap<>();
            h.put("Cache-Control", "no-cache");
            h.put("Access-Control-Allow-Origin", ORIGIN.substring(0, ORIGIN.length() - 1));
            String mime = mime(path);
            return new WebResourceResponse(mime, mime.startsWith("text/") || mime.contains("json") || mime.contains("javascript") ? "utf-8" : null, 200, "OK", h, in);
        } catch (IOException e) {
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not found", new HashMap<String, String>(), new java.io.ByteArrayInputStream(new byte[0]));
        }
    }

    private static String mime(String p) {
        p = p.toLowerCase();
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
        if (p.endsWith(".wasm")) return "application/wasm";
        if (p.endsWith(".json") || p.endsWith(".webmanifest")) return p.endsWith(".json") ? "application/json" : "application/manifest+json";
        if (p.endsWith(".zip")) return "application/zip";
        if (p.endsWith(".woff")) return "font/woff";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".css")) return "text/css";
        return "application/octet-stream";
    }

    private void hideSystemBars() {
        View d = getWindow().getDecorView();
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            android.view.WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(android.view.WindowInsets.Type.systemBars());
                c.setSystemBarsBehavior(android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            d.setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
    }

    @Override public void onWindowFocusChanged(boolean f) { super.onWindowFocusChanged(f); if (f) hideSystemBars(); }

    @Override
    public boolean onKeyDown(int code, KeyEvent e) {
        if (code == KeyEvent.KEYCODE_BACK) {
            // Back = Esc inside the game; if the game has closed, leave the app
            web.evaluateJavascript("window.gvBack ? window.gvBack() : 'quit'", v -> {
                if (v != null && v.contains("quit")) finish();
            });
            return true;
        }
        return super.onKeyDown(code, e);
    }

    @Override protected void onPause() { super.onPause(); if (web != null) web.onPause(); }
    @Override protected void onResume() { super.onResume(); if (web != null) web.onResume(); }
    @Override protected void onDestroy() { if (web != null) web.destroy(); super.onDestroy(); }
}
