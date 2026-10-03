import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import Darwin

private struct DesktopError: Error, CustomStringConvertible {
    let description: String
    init(_ message: String) { description = message }
}

private enum Game: String {
    case factorio
    case minecraft

    func matches(owner: String, title: String) -> Bool {
        let owner = owner.lowercased()
        let title = title.lowercased()
        switch self {
        case .factorio:
            return owner == "factorio"
        case .minecraft:
            return ["java", "javaw", "minecraft"].contains(owner)
                && title.contains("minecraft") && !title.contains("launcher")
        }
    }
}

private struct GameWindow {
    let id: CGWindowID
    let pid: pid_t
    let bounds: CGRect
    let owner: String
    let title: String

    var json: [String: Any] {
        ["windowId": id, "pid": pid, "x": Double(bounds.minX), "y": Double(bounds.minY),
         "width": Double(bounds.width), "height": Double(bounds.height),
         "owner": owner, "title": title]
    }
}

private func window(for game: Game, expectedId: CGWindowID? = nil,
                    foregroundOnly: Bool = true) throws -> GameWindow {
    let frontmostPid = NSWorkspace.shared.frontmostApplication?.processIdentifier
    if foregroundOnly && frontmostPid == nil {
        throw DesktopError("No foreground application; use a logged-in graphical macOS session")
    }
    guard let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] else {
        throw DesktopError("Could not inspect desktop windows")
    }
    let matches: [GameWindow] = rows.compactMap { row in
        guard let owner = row[kCGWindowOwnerName as String] as? String,
              game.matches(owner: owner, title: row[kCGWindowName as String] as? String ?? ""),
              let pid = (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
              (!foregroundOnly || pid == frontmostPid),
              let id = (row[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
              let layer = (row[kCGWindowLayer as String] as? NSNumber)?.intValue,
              layer == 0,
              let rawBounds = row[kCGWindowBounds as String] as? [String: Any],
              let bounds = CGRect(dictionaryRepresentation: rawBounds as CFDictionary),
              bounds.width >= 320, bounds.height >= 240 else { return nil }
        return GameWindow(id: id, pid: pid, bounds: bounds, owner: owner,
                          title: row[kCGWindowName as String] as? String ?? "")
    }
    if let expectedId {
        guard let match = matches.first(where: { $0.id == expectedId }) else {
            throw DesktopError("Game window changed or is no longer foreground; input stopped")
        }
        return match
    }
    guard let largest = matches.max(by: { $0.bounds.width * $0.bounds.height < $1.bounds.width * $1.bounds.height }) else {
        throw DesktopError("No foreground \(game.rawValue) client window found; open the game, not its launcher")
    }
    return largest
}

private func integer(_ row: [String: Any], _ key: String, min: Int, max: Int) throws -> Int {
    guard let number = row[key] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
          number.doubleValue.isFinite, number.doubleValue == Double(number.intValue),
          (min...max).contains(number.intValue) else {
        throw DesktopError("Invalid \(key); expected an integer from \(min) to \(max)")
    }
    return number.intValue
}

private let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "q": 12, "w": 13, "e": 14, "r": 15,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
    "9": 25, "7": 26, "8": 28, "0": 29, "tab": 48, "space": 49,
    "escape": 53, "shift": 56, "control": 59,
    "up": 126, "down": 125, "left": 123, "right": 124,
]

private struct Action {
    let type: String
    let x: Int?
    let y: Int?
    let x2: Int?
    let y2: Int?
    let key: CGKeyCode?
    let keys: [CGKeyCode]?
    let button: String?
    let amount: Int?
    let dx: Int?
    let dy: Int?
    let durationMs: Int
}

private func parseAction(_ row: [String: Any], game: Game) throws -> Action {
    guard let type = row["type"] as? String else { throw DesktopError("Action type is missing") }
    let hasPoint = ["click", "hold_mouse", "drag", "move", "scroll"].contains(type)
    let x = hasPoint ? try integer(row, "x", min: 0, max: 1000) : nil
    let y = hasPoint ? try integer(row, "y", min: 0, max: 1000) : nil
    let x2 = type == "drag" ? try integer(row, "x2", min: 0, max: 1000) : nil
    let y2 = type == "drag" ? try integer(row, "y2", min: 0, max: 1000) : nil
    let duration = ["key", "keys", "click", "hold_mouse", "mouse_button", "drag", "look", "wait"].contains(type)
        ? try integer(row, "durationMs", min: 30, max: 600) : 0
    var key: CGKeyCode?
    var keys: [CGKeyCode]?
    var button: String?
    var amount: Int?
    var dx: Int?
    var dy: Int?
    switch type {
    case "key":
        guard let name = row["key"] as? String, let code = keyCodes[name] else {
            throw DesktopError("Key is not in the game key allowlist")
        }
        if game == .factorio && ["shift", "control"].contains(name) {
            throw DesktopError("Modifier key is reserved for Minecraft")
        }
        key = code
    case "keys":
        guard game == .minecraft, let names = row["keys"] as? [String],
              (2...3).contains(names.count), Set(names).count == names.count else {
            throw DesktopError("Minecraft key combination must contain 2-3 distinct keys")
        }
        let codes = names.compactMap { keyCodes[$0] }
        guard codes.count == names.count else { throw DesktopError("Key is not in the game key allowlist") }
        keys = codes
    case "click", "hold_mouse", "drag":
        guard let requested = row["button"] as? String, ["left", "right"].contains(requested) else {
            throw DesktopError("Mouse button must be left or right")
        }
        button = requested
    case "mouse_button":
        guard game == .minecraft,
              let requested = row["button"] as? String,
              ["left", "right"].contains(requested) else {
            throw DesktopError("Minecraft mouse button must be left or right")
        }
        button = requested
    case "scroll":
        amount = try integer(row, "amount", min: -5, max: 5)
        if amount == 0 { throw DesktopError("Scroll amount cannot be zero") }
    case "look":
        guard game == .minecraft else { throw DesktopError("Relative camera motion is reserved for Minecraft") }
        dx = try integer(row, "dx", min: -120, max: 120)
        dy = try integer(row, "dy", min: -120, max: 120)
        if dx == 0 && dy == 0 { throw DesktopError("Look movement cannot be zero") }
    case "move", "wait": break
    default: throw DesktopError("Unsupported action type")
    }
    return Action(type: type, x: x, y: y, x2: x2, y2: y2, key: key, keys: keys,
                  button: button, amount: amount, dx: dx, dy: dy, durationMs: duration)
}

private func point(_ window: GameWindow, _ x: Int, _ y: Int) -> CGPoint {
    CGPoint(x: window.bounds.minX + (window.bounds.width - 1) * CGFloat(x) / 1000,
            y: window.bounds.minY + (window.bounds.height - 1) * CGFloat(y) / 1000)
}

// A separate process owns a record of held input. If this helper is killed, pipe EOF
// lets the watchdog release only the keys/buttons this action process pressed.
private var watchdogChannel: FileHandle?
private func notifyWatchdog(_ line: String) throws {
    if let channel = watchdogChannel { try channel.write(contentsOf: Data((line + "\n").utf8)) }
}
private func inputWatchdog(dryRun: Bool) throws {
    var keys = Set<CGKeyCode>()
    var buttons = Set<Int>()
    while let line = readLine() {
        if line == "done" { break }
        let parts = line.split(separator: " ")
        guard parts.count == 2, let code = Int(parts[1]) else { throw DesktopError("Invalid watchdog input") }
        switch parts[0] {
        case "key_down", "key_up":
            guard code >= 0 && code <= 127 && keyCodes.values.contains(CGKeyCode(code)) else { throw DesktopError("Invalid watchdog key") }
            if parts[0] == "key_down" { keys.insert(CGKeyCode(code)) } else { keys.remove(CGKeyCode(code)) }
        case "mouse_down", "mouse_up":
            guard code == 0 || code == 1 else { throw DesktopError("Invalid watchdog button") }
            if parts[0] == "mouse_down" { buttons.insert(code) } else { buttons.remove(code) }
        default: throw DesktopError("Invalid watchdog event")
        }
    }
    if dryRun { print("release keys=\(keys.count) buttons=\(buttons.count)"); return }
    var modifiers = Set(keys.filter(isModifier))
    for key in keys.sorted(by: { !isModifier($0) && isModifier($1) }) {
        if isModifier(key) { modifiers.remove(key) }
        try? postKey(key, down: false, heldModifiers: modifiers)
    }
    let location = CGEvent(source: nil)?.location ?? .zero
    for button in buttons {
        try? postMouse(button == 0 ? .leftMouseUp : .rightMouseUp, location,
                       button == 0 ? .left : .right)
    }
}

private func postMouse(_ type: CGEventType, _ location: CGPoint, _ button: CGMouseButton) throws {
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type,
                              mouseCursorPosition: location, mouseButton: button) else {
        throw DesktopError("Could not create mouse event")
    }
    if type == .leftMouseDown || type == .rightMouseDown {
        try notifyWatchdog("mouse_down \(button == .left ? 0 : 1)")
    }
    event.post(tap: .cghidEventTap)
    if type == .leftMouseUp || type == .rightMouseUp {
        try notifyWatchdog("mouse_up \(button == .left ? 0 : 1)")
    }
}

private func isModifier(_ code: CGKeyCode) -> Bool { code == 56 || code == 59 }

private func flags(for held: Set<CGKeyCode>) -> CGEventFlags {
    var result: CGEventFlags = []
    if held.contains(56) { result.insert(.maskShift) }
    if held.contains(59) { result.insert(.maskControl) }
    return result
}

private func postKey(_ code: CGKeyCode, down: Bool, heldModifiers: Set<CGKeyCode>) throws {
    guard let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down) else {
        throw DesktopError("Could not create keyboard event")
    }
    if isModifier(code) { event.type = .flagsChanged }
    event.flags = flags(for: heldModifiers)
    if down { try notifyWatchdog("key_down \(code)") }
    event.post(tap: .cghidEventTap)
    if !down { try notifyWatchdog("key_up \(code)") }
}

private func holdKeys(_ codes: [CGKeyCode], durationMs: Int) throws {
    let ordered = codes.filter(isModifier) + codes.filter { !isModifier($0) }
    var pressed: [CGKeyCode] = []
    var heldModifiers = Set<CGKeyCode>()
    defer {
        for code in pressed.reversed() {
            if isModifier(code) { heldModifiers.remove(code) }
            try? postKey(code, down: false, heldModifiers: heldModifiers)
        }
    }
    for code in ordered {
        if isModifier(code) { heldModifiers.insert(code) }
        try postKey(code, down: true, heldModifiers: heldModifiers)
        pressed.append(code)
    }
    Thread.sleep(forTimeInterval: Double(durationMs) / 1000)
}

private func look(_ dx: Int, _ dy: Int, durationMs: Int, window: GameWindow) throws {
    let pulses = 4
    var sentX = 0
    var sentY = 0
    for step in 1...pulses {
        let nextX = Int((Double(dx * step) / Double(pulses)).rounded())
        let nextY = Int((Double(dy * step) / Double(pulses)).rounded())
        let deltaX = nextX - sentX
        let deltaY = nextY - sentY
        sentX = nextX
        sentY = nextY
        let center = CGPoint(x: window.bounds.midX, y: window.bounds.midY)
        let current = CGEvent(source: nil)?.location ?? center
        let base = window.bounds.contains(current) ? current : center
        let location = CGPoint(
            x: min(window.bounds.maxX - 1, max(window.bounds.minX + 1, base.x + CGFloat(deltaX))),
            y: min(window.bounds.maxY - 1, max(window.bounds.minY + 1, base.y + CGFloat(deltaY))))
        guard let event = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved,
                                  mouseCursorPosition: location, mouseButton: .left) else {
            throw DesktopError("Could not create relative mouse event")
        }
        event.setIntegerValueField(.mouseEventDeltaX, value: Int64(deltaX))
        event.setIntegerValueField(.mouseEventDeltaY, value: Int64(deltaY))
        event.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: Double(durationMs) / Double(pulses * 1000))
    }
}

private func execute(_ action: Action, window: GameWindow) throws {
    if action.type == "wait" {
        Thread.sleep(forTimeInterval: Double(action.durationMs) / 1000)
        return
    }
    if action.type == "key" {
        try holdKeys([action.key!], durationMs: action.durationMs)
        return
    }
    if action.type == "keys" {
        try holdKeys(action.keys!, durationMs: action.durationMs)
        return
    }
    if action.type == "look" {
        try look(action.dx!, action.dy!, durationMs: action.durationMs, window: window)
        return
    }
    let location: CGPoint
    if action.type == "mouse_button" {
        let cursor = CGEvent(source: nil)?.location
        location = cursor.flatMap { window.bounds.contains($0) ? $0 : nil }
            ?? CGPoint(x: window.bounds.midX, y: window.bounds.midY)
    } else {
        location = point(window, action.x!, action.y!)
        try postMouse(.mouseMoved, location, .left)
    }
    if action.type == "move" { return }
    if action.type == "scroll" {
        guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1,
                                  wheel1: Int32(action.amount!), wheel2: 0, wheel3: 0) else {
            throw DesktopError("Could not create scroll event")
        }
        event.post(tap: .cghidEventTap)
        return
    }
    let isRight = action.button == "right"
    let button: CGMouseButton = isRight ? .right : .left
    let downType: CGEventType = isRight ? .rightMouseDown : .leftMouseDown
    let upType: CGEventType = isRight ? .rightMouseUp : .leftMouseUp
    let dragType: CGEventType = isRight ? .rightMouseDragged : .leftMouseDragged
    try postMouse(downType, location, button)
    var releaseAt = location
    defer { try? postMouse(upType, releaseAt, button) }
    if action.type == "drag" {
        let destination = point(window, action.x2!, action.y2!)
        for step in 1...8 {
            let fraction = CGFloat(step) / 8
            releaseAt = CGPoint(x: location.x + (destination.x - location.x) * fraction,
                                y: location.y + (destination.y - location.y) * fraction)
            try postMouse(dragType, releaseAt, button)
            Thread.sleep(forTimeInterval: Double(action.durationMs) / 8000)
        }
    } else {
        Thread.sleep(forTimeInterval: Double(action.durationMs) / 1000)
    }
}

private func run() throws {
    if CommandLine.arguments.count >= 2 && CommandLine.arguments[1] == "watchdog" {
        try inputWatchdog(dryRun: CommandLine.arguments.contains("--dry-run")); return
    }
    guard (3...4).contains(CommandLine.arguments.count) else {
        throw DesktopError("Usage: macos-desktop window|act factorio|minecraft or inspect <game> <window-id>")
    }
    let command = CommandLine.arguments[1]
    guard let game = Game(rawValue: CommandLine.arguments[2].lowercased()) else {
        throw DesktopError("Game must be factorio or minecraft")
    }
    if command == "window" {
        guard CommandLine.arguments.count == 3 else { throw DesktopError("window takes a game name") }
        let data = try JSONSerialization.data(withJSONObject: window(for: game).json)
        print(String(decoding: data, as: UTF8.self))
        return
    }
    if command == "inspect" {
        guard CommandLine.arguments.count == 4,
              let id = UInt32(CommandLine.arguments[3]), id > 0 else {
            throw DesktopError("inspect requires a window ID")
        }
        let data = try JSONSerialization.data(withJSONObject:
            window(for: game, expectedId: id, foregroundOnly: false).json)
        print(String(decoding: data, as: UTF8.self))
        return
    }
    guard command == "act", CommandLine.arguments.count == 3 else {
        throw DesktopError("Unknown command")
    }
    guard AXIsProcessTrusted() else {
        throw DesktopError("Accessibility permission is required for the terminal running this helper")
    }
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard let payload = try JSONSerialization.jsonObject(with: input) as? [String: Any],
          let rawActions = payload["actions"] as? [[String: Any]],
          (1...4).contains(rawActions.count) else {
        throw DesktopError("Expected 1-4 actions")
    }
    let id = try integer(payload, "windowId", min: 1, max: Int(UInt32.max))
    let expectedWidth = try integer(payload, "width", min: 320, max: 100_000)
    let expectedHeight = try integer(payload, "height", min: 240, max: 100_000)
    let actions = try rawActions.map { try parseAction($0, game: game) }
    guard actions.reduce(0, { $0 + $1.durationMs }) <= 2000 else {
        throw DesktopError("Action sequence exceeds 2000 ms")
    }
    let watcher = Process()
    let pipe = Pipe()
    watcher.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
    watcher.arguments = ["watchdog"]
    watcher.standardInput = pipe
    try watcher.run()
    try pipe.fileHandleForReading.close()
    watchdogChannel = pipe.fileHandleForWriting
    defer {
        try? notifyWatchdog("done")
        try? watchdogChannel?.close()
        watchdogChannel = nil
        watcher.waitUntilExit()
    }
    // A terminal Ctrl+C reaches child processes too. Finish the bounded sequence and release
    // its current key/button before the parent exits.
    signal(SIGINT, SIG_IGN)
    signal(SIGTERM, SIG_IGN)
    for action in actions {
        let current = try window(for: game, expectedId: CGWindowID(id))
        guard abs(current.bounds.width - CGFloat(expectedWidth)) <= 2,
              abs(current.bounds.height - CGFloat(expectedHeight)) <= 2 else {
            throw DesktopError("Game window was resized after its screenshot; input stopped")
        }
        try execute(action, window: current)
    }
    print("{\"ok\":true}")
}

do {
    try run()
} catch {
    fputs("macos-desktop: \(error)\n", stderr)
    exit(1)
}
