package io.github.joelruvira.zelda1js

import android.util.Base64
import android.webkit.JavascriptInterface

/**
 * `window.ZeldaNative` for the page (android/web/native.js). These methods run on the WebView's
 * JavaBridge thread; anything that touches views goes through the activity's UI thread.
 * The WebView only ever loads the app's own assets (MainActivity blocks any other navigation).
 */
class NativeBridge(private val activity: MainActivity, private val storage: AppStorage) {

    @JavascriptInterface
    fun hasRom(): Boolean = storage.hasRom()

    /** Opens the system file picker; the answer comes back as ZeldaApp.onRomPicked(status). */
    @JavascriptInterface
    fun pickRom() = activity.runOnUiThread { activity.launchRomPicker() }

    @JavascriptInterface
    fun commitRom(): Boolean = storage.commitCandidate()

    @JavascriptInterface
    fun discardRom() = storage.discardCandidate()

    /** The saved SRAM in base64, or "" when there is none yet. */
    @JavascriptInterface
    fun loadSram(): String = storage.readSram()?.let { Base64.encodeToString(it, Base64.NO_WRAP) } ?: ""

    @JavascriptInterface
    fun saveSram(base64: String): Boolean = try {
        storage.writeSram(Base64.decode(base64, Base64.DEFAULT))
    } catch (e: IllegalArgumentException) {
        false
    }

    @JavascriptInterface
    fun vibrate(ms: Int) = activity.haptic(ms)

    @JavascriptInterface
    fun setKeepScreenOn(on: Boolean) = activity.runOnUiThread { activity.keepScreenOn(on) }

    /** JSON [[left, top, right, bottom], ...] in device pixels of the WebView. */
    @JavascriptInterface
    fun setGestureExclusion(json: String) = activity.runOnUiThread { activity.setGestureExclusion(json) }

    @JavascriptInterface
    fun pageReady() = activity.runOnUiThread { activity.onPageReady() }

    @JavascriptInterface
    fun exitApp() = activity.runOnUiThread { activity.finish() }

    @JavascriptInterface
    fun isDebug(): Boolean = BuildConfig.DEBUG

    /** Debug builds only: results of the self test page. */
    @JavascriptInterface
    fun writeTestResult(name: String, json: String) {
        if (BuildConfig.DEBUG) storage.writeTestResult(name, json)
    }
}
