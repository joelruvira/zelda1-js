package io.github.joelruvira.zelda1js

import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import kotlin.math.abs

/**
 * Physical controllers (Bluetooth / USB) -> NES controller byte, the same layout the game reads
 * (A=$80 B=$40 Select=$20 Start=$10 Up=$08 Down=$04 Left=$02 Right=$01). The mapping follows the web
 * page's standard Gamepad mapping (src/core/input.js): A/Y -> A, B/X -> B, Start, Select, D-pad,
 * hat and left stick. Every change is reported with [onChange]; [onMenu] is the controller's menu/home key.
 */
class GamepadInput(
    private val onChange: (bits: Int) -> Unit,
    private val onMenu: () -> Unit,
) {
    private val keyBits = HashMap<Int, Int>() // deviceId -> buttons held
    private val axisBits = HashMap<Int, Int>() // deviceId -> directions from the stick / hat
    private var last = 0

    val bits: Int
        get() {
            var b = 0
            for (v in keyBits.values) b = b or v
            for (v in axisBits.values) b = b or v
            return b
        }

    /** @return true when the event was a controller key (consumed). */
    fun onKey(event: KeyEvent): Boolean {
        if (!isController(event.source)) return false
        if (event.keyCode == KeyEvent.KEYCODE_BUTTON_MODE || event.keyCode == KeyEvent.KEYCODE_MENU) {
            if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) onMenu()
            return true
        }
        val bit = KEY_BITS[event.keyCode] ?: return false
        val id = event.deviceId
        val held = keyBits[id] ?: 0
        when (event.action) {
            KeyEvent.ACTION_DOWN -> keyBits[id] = held or bit
            KeyEvent.ACTION_UP -> keyBits[id] = held and bit.inv()
            else -> return true
        }
        publish()
        return true
    }

    /** Left stick and hat. @return true when consumed. */
    fun onMotion(event: MotionEvent): Boolean {
        if (event.source and InputDevice.SOURCE_JOYSTICK != InputDevice.SOURCE_JOYSTICK ||
            event.action != MotionEvent.ACTION_MOVE
        ) return false
        val x = dominant(event.getAxisValue(MotionEvent.AXIS_HAT_X), event.getAxisValue(MotionEvent.AXIS_X))
        val y = dominant(event.getAxisValue(MotionEvent.AXIS_HAT_Y), event.getAxisValue(MotionEvent.AXIS_Y))
        var b = 0
        if (x < -STICK_THRESHOLD) b = b or LEFT
        if (x > STICK_THRESHOLD) b = b or RIGHT
        if (y < -STICK_THRESHOLD) b = b or UP
        if (y > STICK_THRESHOLD) b = b or DOWN
        axisBits[event.deviceId] = b
        publish()
        return true
    }

    /** A controller was unplugged: release its buttons. */
    fun onDeviceRemoved(deviceId: Int) {
        keyBits.remove(deviceId)
        axisBits.remove(deviceId)
        publish()
    }

    /** The app lost the input focus (background): a key-up may never arrive, release everything. */
    fun releaseAll() {
        keyBits.clear()
        axisBits.clear()
        publish()
    }

    private fun publish() {
        val b = bits
        if (b != last) {
            last = b
            onChange(b)
        }
    }

    private fun dominant(hat: Float, stick: Float) = if (abs(hat) >= abs(stick)) hat else stick

    companion object {
        const val A = 0x80
        const val B = 0x40
        const val SELECT = 0x20
        const val START = 0x10
        const val UP = 0x08
        const val DOWN = 0x04
        const val LEFT = 0x02
        const val RIGHT = 0x01
        const val STICK_THRESHOLD = 0.5f

        val KEY_BITS = mapOf(
            KeyEvent.KEYCODE_BUTTON_A to A,
            KeyEvent.KEYCODE_BUTTON_Y to A,
            KeyEvent.KEYCODE_BUTTON_B to B,
            KeyEvent.KEYCODE_BUTTON_X to B,
            KeyEvent.KEYCODE_BUTTON_START to START,
            KeyEvent.KEYCODE_BUTTON_SELECT to SELECT,
            KeyEvent.KEYCODE_DPAD_UP to UP,
            KeyEvent.KEYCODE_DPAD_DOWN to DOWN,
            KeyEvent.KEYCODE_DPAD_LEFT to LEFT,
            KeyEvent.KEYCODE_DPAD_RIGHT to RIGHT,
            KeyEvent.KEYCODE_DPAD_UP_LEFT to (UP or LEFT),
            KeyEvent.KEYCODE_DPAD_UP_RIGHT to (UP or RIGHT),
            KeyEvent.KEYCODE_DPAD_DOWN_LEFT to (DOWN or LEFT),
            KeyEvent.KEYCODE_DPAD_DOWN_RIGHT to (DOWN or RIGHT),
        )

        fun isController(source: Int): Boolean =
            source and InputDevice.SOURCE_GAMEPAD == InputDevice.SOURCE_GAMEPAD ||
                source and InputDevice.SOURCE_JOYSTICK == InputDevice.SOURCE_JOYSTICK ||
                source and InputDevice.SOURCE_DPAD == InputDevice.SOURCE_DPAD

        fun isControllerDevice(device: InputDevice?): Boolean =
            device != null && !device.isVirtual && (
                device.sources and InputDevice.SOURCE_GAMEPAD == InputDevice.SOURCE_GAMEPAD ||
                    device.sources and InputDevice.SOURCE_JOYSTICK == InputDevice.SOURCE_JOYSTICK
                )
    }
}
