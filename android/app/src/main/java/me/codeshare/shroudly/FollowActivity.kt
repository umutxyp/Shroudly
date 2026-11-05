package me.codeshare.shroudly

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast

/*
 * Follow Shroudly (About → Follow Shroudly): Codeshare's accounts, then its
 * developer's. A tap opens one in its app or the browser. A TV may have no
 * browser at all, so there the address is shown in full under each name,
 * to be opened on a phone or computer, and a tap that finds nothing to open
 * it with says the address. The same list as the desktop's
 * (components/follow.json, tests/net/follow.test.js) and the Apple app's.
 */
class FollowActivity : Activity() {
    override fun attachBaseContext(base: android.content.Context) = super.attachBaseContext(Lang.wrap(base))

    data class Link(val name: String, val handle: String, val url: String)

    companion object {
        val CODESHARE = listOf(
            Link("Instagram", "@codeshareme", "https://instagram.com/codeshareme"),
            Link("X", "@codeshareme", "https://x.com/codeshareme"),
            Link("Discord", "Codeshare", "https://discord.gg/BhdgVfsFVC"),
            Link("LinkedIn", "codeshareme", "https://www.linkedin.com/company/codeshareme"),
            Link("Facebook", "codeshareme", "https://www.facebook.com/codeshareme"),
            Link("GitHub", "codeshareme", "https://github.com/codeshareme"),
            Link("codeshare.me", "codeshare.me", "https://codeshare.me"),
        )
        val DEVELOPER = listOf(
            Link("Instagram", "@umutxyp", "https://instagram.com/umutxyp"),
            Link("YouTube", "@umutxyp", "https://youtube.com/@umutxyp"),
            Link("TikTok", "@umutxyp", "https://tiktok.com/@umutxyp"),
            Link("X", "@devbayraktar", "https://x.com/devbayraktar"),
            Link("Telegram", "@umutxyp", "https://t.me/umutxyp"),
            Link("GitHub", "umutxyp", "https://github.com/umutxyp"),
            Link("LinkedIn", "umutxyp", "https://linkedin.com/in/umutxyp"),
            Link("Facebook", "umutxyp", "https://facebook.com/umutxyp"),
        )
    }

    private fun dp(v: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, resources.displayMetrics).toInt()

    private fun label(size: Float, color: Int, bold: Boolean = false) = TextView(this).apply {
        setTextSize(TypedValue.COMPLEX_UNIT_SP, size)
        setTextColor(getColor(color))
        if (bold) setTypeface(typeface, Typeface.BOLD)
        textAlignment = View.TEXT_ALIGNMENT_VIEW_START
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        Accent.apply(this)
        super.onCreate(savedInstanceState)
        val tv = Tv.isTv(this)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16f), dp(16f), dp(16f), dp(16f))
        }
        root.addView(label(20f, R.color.text, true).apply { setText(R.string.followTitle) })
        root.addView(label(13f, R.color.text_dim).apply { setText(R.string.followDesc); setPadding(0, dp(4f), 0, dp(8f)) })
        if (tv) root.addView(label(13f, R.color.text_dim).apply { setText(R.string.followTv); setPadding(0, 0, 0, dp(8f)) })
        group(root, getString(R.string.followCodeshare), CODESHARE, tv)
        group(root, getString(R.string.followDeveloper), DEVELOPER, tv)
        val scroll = ScrollView(this).apply { id = View.generateViewId(); addView(root); setBackgroundColor(getColor(R.color.bg)) }
        setContentView(scroll)
        Tv.rings(window)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) {
                @Suppress("DEPRECATION")
                window.setDecorFitsSystemWindows(false)
            }
            scroll.setOnApplyWindowInsetsListener { v, insets ->
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                insets
            }
        }
    }

    private fun group(root: LinearLayout, title: String, links: List<Link>, tv: Boolean) {
        root.addView(label(12f, R.color.text_faint, true).apply { text = title; setPadding(0, dp(12f), 0, dp(4f)) })
        for (l in links) {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(12f), dp(10f), dp(12f), dp(10f))
                isFocusable = true
                isClickable = true
                setBackgroundResource(R.drawable.card)
                contentDescription = "${l.name} ${l.handle}"
                setOnClickListener { open(l) }
            }
            row.addView(label(15f, R.color.text).apply { text = l.name })
            row.addView(label(12.5f, R.color.text_faint).apply {
                text = if (tv) l.url.removePrefix("https://") else l.handle
                textDirection = View.TEXT_DIRECTION_LTR
            })
            root.addView(row, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(6f) })
        }
    }

    private fun open(l: Link) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(l.url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, l.url.removePrefix("https://"), Toast.LENGTH_LONG).show()
        } catch (_: Exception) {
            Toast.makeText(this, l.url.removePrefix("https://"), Toast.LENGTH_LONG).show()
        }
    }
}
