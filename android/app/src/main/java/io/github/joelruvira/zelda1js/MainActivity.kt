package io.github.joelruvira.zelda1js

import android.annotation.SuppressLint
import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Rect
import android.hardware.input.InputManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewAssetLoader
import org.json.JSONArray
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream
import java.util.concurrent.Executors

/**
 * The whole app: one full-screen WebView that runs the web game (src/ + android/web/, copied into the
 * assets at build time) from https://appassets.androidplatform.net, so ES modules, fetch and the
 * AudioWorklet work as on the web. The ROM is packed into the APK at build time (assets/rom/zelda.nes,
 * scripts/android/rom-asset.mjs). Native parts: immersive landscape, private storage for the saved games,
 * haptics, physical controllers, back button and lifecycle, and a fallback ROM picker that the page only
 * uses if the packed ROM were missing or invalid.
 */
class MainActivity : ComponentActivity() {
    private lateinit var webView: WebView
    private lateinit var storage: AppStorage
    private var vibrator: Vibrator? = null
    private var pageReady = false
    private var rendererGone = false
    private var cutout = Rect()
    private val io = Executors.newSingleThreadExecutor()

    private val gamepad = GamepadInput(
        onChange = { bits -> js("ZeldaApp.onPad($bits)") },
        onMenu = { js("ZeldaApp.onBack()") },
    )

    private val romPicker = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        if (uri == null) {
            js("ZeldaApp.onRomPicked('cancel')")
            return@registerForActivityResult
        }
        io.execute {
            val status = try {
                contentResolver.openInputStream(uri)?.let { storage.storeCandidate(it) } ?: "error"
            } catch (e: Exception) {
                Log.w(TAG, "ROM copy failed", e)
                "error"
            }
            runOnUiThread { js("ZeldaApp.onRomPicked('$status')") }
        }
    }

    private val inputDevices = object : InputManager.InputDeviceListener {
        override fun onInputDeviceAdded(deviceId: Int) {
            if (GamepadInput.isControllerDevice(InputDevice.getDevice(deviceId))) js("ZeldaApp.onPad(${gamepad.bits})")
        }
        override fun onInputDeviceRemoved(deviceId: Int) = gamepad.onDeviceRemoved(deviceId)
        override fun onInputDeviceChanged(deviceId: Int) {}
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        storage = AppStorage(this)
        vibrator = if (Build.VERSION.SDK_INT >= 31) {
            (getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        }

        WindowCompat.setDecorFitsSystemWindows(window, false)
        if (Build.VERSION.SDK_INT >= 30) {
            window.attributes.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
        } else if (Build.VERSION.SDK_INT >= 28) {
            window.attributes.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        webView = WebView(this)
        webView.setBackgroundColor(Color.BLACK)
        webView.overScrollMode = View.OVER_SCROLL_NEVER
        webView.isVerticalScrollBarEnabled = false
        webView.isHorizontalScrollBarEnabled = false
        webView.isLongClickable = false
        webView.isHapticFeedbackEnabled = false
        webView.setOnLongClickListener { true }
        webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, true)
        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            textZoom = 100
            useWideViewPort = true
            loadWithOverviewMode = false
            cacheMode = WebSettings.LOAD_NO_CACHE
            offscreenPreRaster = true
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            if (Build.VERSION.SDK_INT >= 26) safeBrowsingEnabled = false
        }

        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/native/", NativeFiles(storage))
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                if (request.url.host != WebViewAssetLoader.DEFAULT_DOMAIN) return notFound() // nothing leaves the app
                return loader.shouldInterceptRequest(request.url) ?: notFound()
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true

            // The renderer runs in its own process and may be killed while the app is in the background
            // (memory pressure; its priority is waived when not visible). Without this override the whole
            // app would be killed with it: start over with a fresh WebView instead (the SRAM was saved on pause).
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                Log.w(TAG, "WebView renderer gone (crash: ${detail.didCrash()})")
                pageReady = false
                rendererGone = true
                if (detail.didCrash()) finish() else recreate()
                return true
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                Log.println(
                    if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR) Log.ERROR else Log.INFO,
                    "ZeldaWeb",
                    "${message.message()} (${message.sourceId().substringAfterLast('/')}:${message.lineNumber()})",
                )
                return true
            }
        }
        webView.addJavascriptInterface(NativeBridge(this, storage), "ZeldaNative")
        setContentView(webView)

        ViewCompat.setOnApplyWindowInsetsListener(webView) { _, insets ->
            val c = insets.getInsets(WindowInsetsCompat.Type.displayCutout())
            cutout = Rect(c.left, c.top, c.right, c.bottom)
            sendInsets()
            WindowInsetsCompat.CONSUMED
        }
        webView.addOnLayoutChangeListener { _, l, t, r, b, ol, ot, oRight, ob ->
            if (r - l != oRight - ol || b - t != ob - ot) sendInsets()
        }
        hideSystemBars()

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (!pageReady) { finish(); return }
                webView.evaluateJavascript("ZeldaApp.onBack()") { handled -> if (handled != "true") finish() }
            }
        })
        (getSystemService(Context.INPUT_SERVICE) as InputManager).registerInputDeviceListener(inputDevices, null)

        webView.loadUrl(startUrl())
    }

    private fun startUrl(): String {
        val base = "https://${WebViewAssetLoader.DEFAULT_DOMAIN}/assets/www/android/web/"
        val selftest = if (BuildConfig.DEBUG) intent?.getStringExtra("selftest") else null
        return if (selftest != null) "${base}selftest.html?movies=${Uri.encode(selftest)}" else "${base}index.html"
    }

    private fun notFound() = WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))

    /** Serves rom/zelda.nes and rom/candidate.nes from the private storage at /native/rom/... */
    private class NativeFiles(private val storage: AppStorage) : WebViewAssetLoader.PathHandler {
        override fun handle(path: String): WebResourceResponse? {
            val file: File = when (path) {
                "rom/zelda.nes" -> storage.romFile
                "rom/candidate.nes" -> storage.candidateFile
                else -> return null
            }
            if (!file.isFile) return null
            return WebResourceResponse(
                "application/octet-stream", null, 200, "OK",
                mapOf("Cache-Control" to "no-store"), FileInputStream(file),
            )
        }
    }

    // ------------------------------------------------------------------ page <-> app

    private fun js(code: String) {
        if (pageReady) webView.evaluateJavascript(code, null)
    }

    fun onPageReady() {
        pageReady = true
        sendInsets()
        val ids = InputDevice.getDeviceIds()
        if (ids.any { GamepadInput.isControllerDevice(InputDevice.getDevice(it)) }) js("ZeldaApp.onPad(${gamepad.bits})")
    }

    private fun sendInsets() =
        js("ZeldaApp.onInsets(${cutout.left}, ${cutout.top}, ${cutout.right}, ${cutout.bottom}, ${webView.width}, ${webView.height})")

    fun launchRomPicker() {
        try {
            romPicker.launch(arrayOf("*/*"))
        } catch (e: Exception) {
            Log.w(TAG, "no document picker", e)
            js("ZeldaApp.onRomPicked('error')")
        }
    }

    fun keepScreenOn(on: Boolean) {
        if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    fun setGestureExclusion(json: String) {
        if (Build.VERSION.SDK_INT < 29) return
        val rects = ArrayList<Rect>()
        try {
            val a = JSONArray(json)
            for (i in 0 until a.length()) {
                val r = a.getJSONArray(i)
                rects.add(Rect(r.getInt(0), r.getInt(1), r.getInt(2), r.getInt(3)))
            }
        } catch (e: Exception) {
            return
        }
        webView.systemGestureExclusionRects = rects
    }

    /** Short haptic tick for a touch control (respects the system's touch-vibration setting). */
    fun haptic(ms: Int) {
        val v = vibrator ?: return
        if (!v.hasVibrator()) return
        val effect = if (Build.VERSION.SDK_INT >= 29) {
            VibrationEffect.createPredefined(if (ms >= 15) VibrationEffect.EFFECT_CLICK else VibrationEffect.EFFECT_TICK)
        } else {
            VibrationEffect.createOneShot(ms.toLong().coerceIn(5, 40), VibrationEffect.DEFAULT_AMPLITUDE)
        }
        if (Build.VERSION.SDK_INT >= 33) v.vibrate(effect, VibrationAttributes.createForUsage(VibrationAttributes.USAGE_TOUCH))
        else v.vibrate(effect)
    }

    private fun hideSystemBars() {
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        controller.hide(WindowInsetsCompat.Type.systemBars())
    }

    // ------------------------------------------------------------------ controllers

    override fun dispatchKeyEvent(event: KeyEvent): Boolean =
        gamepad.onKey(event) || super.dispatchKeyEvent(event)

    override fun dispatchGenericMotionEvent(event: MotionEvent): Boolean =
        gamepad.onMotion(event) || super.dispatchGenericMotionEvent(event)

    // ------------------------------------------------------------------ lifecycle

    override fun onResume() {
        super.onResume()
        hideSystemBars()
        if (!rendererGone) webView.onResume()
        js("ZeldaApp.onResume()")
    }

    override fun onPause() {
        // controller buttons held now would never get their key-up: release them first
        gamepad.releaseAll()
        // the page stops the game, silences the audio and writes the SRAM if it changed
        js("ZeldaApp.onPause()")
        if (!rendererGone) webView.onPause()
        super.onPause()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        hideSystemBars()
    }

    override fun onDestroy() {
        pageReady = false // late callbacks (ROM copy thread) must not touch the destroyed WebView
        (getSystemService(Context.INPUT_SERVICE) as InputManager).unregisterInputDeviceListener(inputDevices)
        io.shutdown()
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.destroy()
        super.onDestroy()
    }

    companion object {
        private const val TAG = "Zelda1Js"
    }
}
