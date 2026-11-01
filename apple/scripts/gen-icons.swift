#!/usr/bin/env swift
/*
 * The app's icons from public/icon.png (the shield the desktop and Android
 * use), on the Android launcher's dark background (#0B0F17):
 *  - iPhone and iPad: one 1024 px square, opaque (the App Store refuses an
 *    icon with an alpha channel); the system rounds its corners;
 *  - Mac: 16 to 1024 px, a rounded square on the macOS icon grid (824 px of
 *    1024, the rest transparent), as Mac icons are drawn;
 *  - Logo: 256 px of the square, for About.
 * Writes App/Assets.xcassets/{AppIcon.appiconset,Logo.imageset}. Run from
 * the repository's root after the shield changes:
 *
 *   swift apple/scripts/gen-icons.swift
 */
import AppKit
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let source = root.appendingPathComponent("public/icon.png")
let assets = root.appendingPathComponent("apple/App/Assets.xcassets")
guard let src = CGImageSourceCreateWithURL(source as CFURL, nil),
      let shield = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
    fatalError("cannot read \(source.path)")
}
let background = CGColor(red: 0x0B / 255, green: 0x0F / 255, blue: 0x17 / 255, alpha: 1)

func draw(_ size: Int, opaque: Bool, _ body: (CGContext) -> Void) -> CGImage {
    let info = opaque ? CGImageAlphaInfo.noneSkipLast.rawValue : CGImageAlphaInfo.premultipliedLast.rawValue
    let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: info)!
    ctx.interpolationQuality = .high
    body(ctx)
    return ctx.makeImage()!
}

/* The square: background and shield, full bleed. */
func square(_ size: Int) -> CGImage {
    draw(size, opaque: true) { ctx in
        let r = CGRect(x: 0, y: 0, width: size, height: size)
        ctx.setFillColor(background)
        ctx.fill(r)
        ctx.draw(shield, in: r)
    }
}

/* The Mac icon: the square as a rounded square on the 1024 grid. */
func mac(_ size: Int) -> CGImage {
    draw(size, opaque: false) { ctx in
        let s = CGFloat(size) / 1024
        let rect = CGRect(x: 100 * s, y: 100 * s, width: 824 * s, height: 824 * s)
        let path = CGPath(roundedRect: rect, cornerWidth: 185 * s, cornerHeight: 185 * s, transform: nil)
        ctx.saveGState()
        ctx.setShadow(offset: CGSize(width: 0, height: -10 * s), blur: 20 * s, color: CGColor(gray: 0, alpha: 0.35))
        ctx.addPath(path)
        ctx.setFillColor(background)
        ctx.fillPath()
        ctx.restoreGState()
        ctx.addPath(path)
        ctx.clip()
        ctx.draw(shield, in: rect)
    }
}

func write(_ image: CGImage, _ url: URL) {
    let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else { fatalError("cannot write \(url.path)") }
}

func json(_ obj: Any, _ url: URL) {
    let data = try! JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys])
    try! (String(decoding: data, as: UTF8.self) + "\n").write(to: url, atomically: true, encoding: .utf8)
}

let fm = FileManager.default
let iconSet = assets.appendingPathComponent("AppIcon.appiconset")
let logoSet = assets.appendingPathComponent("Logo.imageset")
for d in [iconSet, logoSet] {
    try? fm.removeItem(at: d)
    try! fm.createDirectory(at: d, withIntermediateDirectories: true)
}

write(square(1024), iconSet.appendingPathComponent("ios-1024.png"))
var images: [[String: String]] = [["filename": "ios-1024.png", "idiom": "universal", "platform": "ios", "size": "1024x1024"]]
for px in [16, 32, 64, 128, 256, 512, 1024] {
    write(mac(px), iconSet.appendingPathComponent("mac-\(px).png"))
}
for (pt, scale) in [(16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2), (256, 1), (256, 2), (512, 1), (512, 2)] {
    images.append(["filename": "mac-\(pt * scale).png", "idiom": "mac", "scale": "\(scale)x", "size": "\(pt)x\(pt)"])
}
json(["images": images, "info": ["author": "xcode", "version": 1]], iconSet.appendingPathComponent("Contents.json"))

write(square(256), logoSet.appendingPathComponent("logo.png"))
json(["images": [["filename": "logo.png", "idiom": "universal"]], "info": ["author": "xcode", "version": 1]],
     logoSet.appendingPathComponent("Contents.json"))
print("[icons] written to \(assets.path)")
