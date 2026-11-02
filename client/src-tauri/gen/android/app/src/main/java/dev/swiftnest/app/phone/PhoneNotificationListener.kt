package dev.swiftnest.app.phone

import android.app.Notification
import android.service.notification.NotificationListenerService
import org.json.JSONArray
import org.json.JSONObject

/** Reads the phone's current notifications once the owner grants notification access in system settings. */
class PhoneNotificationListener : NotificationListenerService() {
  companion object {
    @Volatile
    var instance: PhoneNotificationListener? = null
      private set
  }

  override fun onListenerConnected() {
    instance = this
  }

  override fun onListenerDisconnected() {
    instance = null
  }

  /** Newest first; app label falls back to the package name. */
  fun recent(limit: Int): JSONArray {
    val apps = packageManager
    val list = JSONArray()
    activeNotifications
      .sortedByDescending { it.postTime }
      .take(limit)
      .forEach { item ->
        val extras = item.notification.extras
        val label = runCatching {
          apps.getApplicationLabel(apps.getApplicationInfo(item.packageName, 0)).toString()
        }.getOrDefault(item.packageName)
        list.put(
          JSONObject()
            .put("app", label)
            .put("package", item.packageName)
            .put("title", extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty())
            .put("text", extras.getCharSequence(Notification.EXTRA_TEXT)?.toString().orEmpty())
            .put("time", item.postTime)
        )
      }
    return list
  }
}
