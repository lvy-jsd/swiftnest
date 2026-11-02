package dev.swiftnest.app.phone

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * Sees and acts on the phone screen for Swiftnest. The owner turns it on in the system's accessibility
 * settings; while it is off, every screen/input tool reports that clearly instead of doing anything.
 */
class PhoneAccessibilityService : AccessibilityService() {
  companion object {
    @Volatile
    var instance: PhoneAccessibilityService? = null
      private set

    private const val MAX_NODES = 400
  }

  private val callbacks = HandlerThread("swiftnest-accessibility").apply { start() }
  private val handler = Handler(callbacks.looper)
  private val screenshots = Executors.newSingleThreadExecutor()

  override fun onServiceConnected() {
    instance = this
  }

  override fun onDestroy() {
    instance = null
    callbacks.quitSafely()
    screenshots.shutdown()
    super.onDestroy()
  }

  override fun onAccessibilityEvent(event: AccessibilityEvent?) {}

  override fun onInterrupt() {}

  /** Visible elements of the active window, in screen pixels. */
  fun uiTree(): JSONArray {
    val nodes = JSONArray()
    val root = rootInActiveWindow ?: return nodes
    collect(root, depth = 0, out = nodes)
    return nodes
  }

  private fun collect(node: AccessibilityNodeInfo, depth: Int, out: JSONArray) {
    if (out.length() >= MAX_NODES || !node.isVisibleToUser) return
    val text = node.text?.toString().orEmpty()
    val description = node.contentDescription?.toString().orEmpty()
    if (text.isNotEmpty() || description.isNotEmpty() || node.isClickable || node.isEditable) {
      val bounds = Rect().also(node::getBoundsInScreen)
      out.put(
        JSONObject()
          .put("depth", depth)
          .put("text", text)
          .put("description", description)
          .put("class", node.className?.toString().orEmpty())
          .put("bounds", JSONArray(listOf(bounds.left, bounds.top, bounds.right, bounds.bottom)))
          .put("clickable", node.isClickable)
          .put("editable", node.isEditable)
          .put("focused", node.isFocused)
      )
    }
    for (index in 0 until node.childCount) {
      node.getChild(index)?.let { collect(it, depth + 1, out) }
    }
  }

  fun tap(x: Float, y: Float, done: (Boolean) -> Unit) {
    val path = Path().apply { moveTo(x, y) }
    gesture(GestureDescription.StrokeDescription(path, 0, 60), done)
  }

  fun swipe(x1: Float, y1: Float, x2: Float, y2: Float, durationMs: Long, done: (Boolean) -> Unit) {
    val path = Path().apply {
      moveTo(x1, y1)
      lineTo(x2, y2)
    }
    gesture(GestureDescription.StrokeDescription(path, 0, durationMs.coerceIn(50, 5000)), done)
  }

  private fun gesture(stroke: GestureDescription.StrokeDescription, done: (Boolean) -> Unit) {
    val description = GestureDescription.Builder().addStroke(stroke).build()
    val callback = object : GestureResultCallback() {
      override fun onCompleted(gestureDescription: GestureDescription?) = done(true)
      override fun onCancelled(gestureDescription: GestureDescription?) = done(false)
    }
    if (!dispatchGesture(description, callback, handler)) done(false)
  }

  /** Replaces the text of the focused input field. */
  fun typeText(text: String): Boolean {
    val field = rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return false
    val arguments = Bundle().apply {
      putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
    }
    return field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)
  }

  fun pressKey(key: String): Boolean {
    val action = when (key) {
      "back" -> GLOBAL_ACTION_BACK
      "home" -> GLOBAL_ACTION_HOME
      "recents" -> GLOBAL_ACTION_RECENTS
      "notifications" -> GLOBAL_ACTION_NOTIFICATIONS
      else -> return false
    }
    return performGlobalAction(action)
  }

  /** Screenshot of the default display (Android 11+). `done` gets a software bitmap or an error code. */
  fun screenshot(done: (Bitmap?, String?) -> Unit) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
      done(null, "ANDROID_TOO_OLD")
      return
    }
    takeScreenshot(Display.DEFAULT_DISPLAY, screenshots, object : TakeScreenshotCallback {
      override fun onSuccess(result: ScreenshotResult) {
        val hardware = Bitmap.wrapHardwareBuffer(result.hardwareBuffer, result.colorSpace)
        val bitmap = hardware?.copy(Bitmap.Config.ARGB_8888, false)
        result.hardwareBuffer.close()
        done(bitmap, if (bitmap == null) "SCREENSHOT_FAILED" else null)
      }

      override fun onFailure(errorCode: Int) = done(null, "SCREENSHOT_FAILED")
    })
  }
}
