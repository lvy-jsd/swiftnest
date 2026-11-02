package dev.swiftnest.app.phone

import android.Manifest
import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.os.Build
import android.provider.Settings
import android.util.Base64
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.roundToInt

@InvokeArg
class PointArgs {
  var x: Double = 0.0
  var y: Double = 0.0
}

@InvokeArg
class SwipeArgs {
  var x1: Double = 0.0
  var y1: Double = 0.0
  var x2: Double = 0.0
  var y2: Double = 0.0
  var durationMs: Long = 300
}

@InvokeArg
class TextArgs {
  lateinit var text: String
}

@InvokeArg
class KeyArgs {
  lateinit var key: String
}

@InvokeArg
class ScreenshotArgs {
  var maxDimension: Int = 1280
}

@InvokeArg
class LimitArgs {
  var limit: Int = 20
}

@InvokeArg
class PostArgs {
  lateinit var title: String
  var text: String? = null
}

@InvokeArg
class PackageArgs {
  lateinit var `package`: String
}

@InvokeArg
class SettingsArgs {
  lateinit var kind: String
}

/**
 * The phone side of Swiftnest's phone capabilities. Rust forwards each approved tool call here; every
 * command answers with plain data or rejects with a stable error code the core turns into a message.
 */
@TauriPlugin
class PhonePlugin(private val activity: Activity) : Plugin(activity) {
  private val context: Context get() = activity.applicationContext

  private fun accessibility(invoke: Invoke): PhoneAccessibilityService? =
    PhoneAccessibilityService.instance.also {
      if (it == null) invoke.reject("Accessibility service is off", "ACCESSIBILITY_OFF")
    }

  private fun done(invoke: Invoke, ok: Boolean, failure: String) {
    if (ok) invoke.resolve(JSObject().put("ok", true)) else invoke.reject(failure, "ACTION_FAILED")
  }

  /** Which system permissions the owner has granted, for the "This device" page. */
  @Command
  fun status(invoke: Invoke) {
    invoke.resolve(
      JSObject()
        .put("accessibility", PhoneAccessibilityService.instance != null)
        .put("notifications", PhoneNotificationListener.instance != null)
        .put("postNotifications", NotificationManagerCompat.from(context).areNotificationsEnabled())
        .put("sdk", Build.VERSION.SDK_INT)
    )
  }

  /** Opens the system page where the owner turns a permission on. */
  @Command
  fun openSettings(invoke: Invoke) {
    val action = when (invoke.parseArgs(SettingsArgs::class.java).kind) {
      "accessibility" -> Settings.ACTION_ACCESSIBILITY_SETTINGS
      "notifications" -> Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS
      else -> return invoke.reject("Unknown settings page", "BAD_ARGS")
    }
    activity.startActivity(Intent(action))
    invoke.resolve()
  }

  @Command
  fun uiTree(invoke: Invoke) {
    val service = accessibility(invoke) ?: return
    invoke.resolve(JSObject().put("nodes", JSArray(service.uiTree().toString())))
  }

  @Command
  fun tap(invoke: Invoke) {
    val service = accessibility(invoke) ?: return
    val args = invoke.parseArgs(PointArgs::class.java)
    service.tap(args.x.toFloat(), args.y.toFloat()) { done(invoke, it, "Tap was cancelled") }
  }

  @Command
  fun swipe(invoke: Invoke) {
    val service = accessibility(invoke) ?: return
    val args = invoke.parseArgs(SwipeArgs::class.java)
    service.swipe(args.x1.toFloat(), args.y1.toFloat(), args.x2.toFloat(), args.y2.toFloat(), args.durationMs) {
      done(invoke, it, "Swipe was cancelled")
    }
  }

  @Command
  fun typeText(invoke: Invoke) {
    val service = accessibility(invoke) ?: return
    val text = invoke.parseArgs(TextArgs::class.java).text
    done(invoke, service.typeText(text), "No focused text field")
  }

  @Command
  fun pressKey(invoke: Invoke) {
    val service = accessibility(invoke) ?: return
    done(invoke, service.pressKey(invoke.parseArgs(KeyArgs::class.java).key), "Key was not accepted")
  }

  @Command
  fun screenInfo(invoke: Invoke) {
    val metrics = context.resources.displayMetrics
    invoke.resolve(
      JSObject()
        .put("width", metrics.widthPixels)
        .put("height", metrics.heightPixels)
        .put("density", metrics.density.toDouble())
        .put("accessibility", PhoneAccessibilityService.instance != null)
    )
  }

  @Command
  fun screenshot(invoke: Invoke) {
    val service = accessibility(invoke) ?: return
    val maxDimension = invoke.parseArgs(ScreenshotArgs::class.java).maxDimension.coerceIn(64, 4096)
    service.screenshot { bitmap, error ->
      if (bitmap == null) return@screenshot invoke.reject("Screenshot failed", error ?: "SCREENSHOT_FAILED")
      val scale = minOf(1.0, maxDimension.toDouble() / max(bitmap.width, bitmap.height))
      val scaled = Bitmap.createScaledBitmap(
        bitmap,
        (bitmap.width * scale).roundToInt(),
        (bitmap.height * scale).roundToInt(),
        true,
      )
      val png = ByteArrayOutputStream().also { scaled.compress(Bitmap.CompressFormat.PNG, 100, it) }
      invoke.resolve(
        JSObject()
          .put("format", "png")
          .put("data", Base64.encodeToString(png.toByteArray(), Base64.NO_WRAP))
          .put("width", scaled.width)
          .put("height", scaled.height)
          .put("scaleFactor", scale)
      )
    }
  }

  @Command
  fun listNotifications(invoke: Invoke) {
    val listener = PhoneNotificationListener.instance
      ?: return invoke.reject("Notification access is off", "NOTIFICATION_ACCESS_OFF")
    val limit = invoke.parseArgs(LimitArgs::class.java).limit.coerceIn(1, 50)
    invoke.resolve(JSObject().put("notifications", JSArray(listener.recent(limit).toString())))
  }

  @Command
  fun postNotification(invoke: Invoke) {
    if (Build.VERSION.SDK_INT >= 33 &&
      ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) {
      ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 0)
      return invoke.reject("Allow Swiftnest to show notifications, then try again", "NOTIFICATIONS_BLOCKED")
    }
    val args = invoke.parseArgs(PostArgs::class.java)
    val manager = context.getSystemService(NotificationManager::class.java)
    val channel = "swiftnest"
    manager.createNotificationChannel(
      NotificationChannel(channel, context.getString(dev.swiftnest.app.R.string.notification_channel), NotificationManager.IMPORTANCE_DEFAULT)
    )
    val notification = NotificationCompat.Builder(context, channel)
      .setSmallIcon(dev.swiftnest.app.R.mipmap.ic_launcher)
      .setContentTitle(args.title)
      .setContentText(args.text.orEmpty())
      .setAutoCancel(true)
      .build()
    manager.notify(System.currentTimeMillis().toInt(), notification)
    invoke.resolve(JSObject().put("ok", true))
  }

  @Command
  fun listApps(invoke: Invoke) {
    val apps = context.packageManager
    val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
    val list = JSArray()
    apps.queryIntentActivities(launcher, 0)
      .map { JSObject().put("name", it.loadLabel(apps).toString()).put("package", it.activityInfo.packageName) }
      .distinctBy { it.getString("package") }
      .sortedBy { it.getString("name") }
      .forEach { list.put(it) }
    invoke.resolve(JSObject().put("apps", list))
  }

  @Command
  fun openApp(invoke: Invoke) {
    val name = invoke.parseArgs(PackageArgs::class.java).`package`
    val intent = context.packageManager.getLaunchIntentForPackage(name)
      ?: return invoke.reject("App not found", "APP_NOT_FOUND")
    activity.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    invoke.resolve(JSObject().put("ok", true))
  }
}
