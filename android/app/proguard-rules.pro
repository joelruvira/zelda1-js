# Methods called from JavaScript (ZeldaNative): keep their names.
-keepclassmembers class io.github.joelruvira.zelda1js.NativeBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface
