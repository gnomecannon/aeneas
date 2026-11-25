# Planned

Features the owner asked for that are not built yet, with what was found about them. Each entry says what it would do,
what stands in the way, and how it would be built.

## HomeKit (asked for 2026-11-25)

What it would do: show your home's accessories (lights, plugs, thermostats, locks, sensors) in Aeneas, let the
assistant answer "is the garage door closed?" and turn things on or off when you ask, and bring HomeKit sensors'
readings into Sensors.

What stands in the way:
- Apple lets an app read or control HomeKit only while it is open on the screen. A request that comes while the app is
  closed or in the background fails, and there is no public way around it. So the hub, which runs the assistant, can
  never reach your home by itself; only an open iPhone or iPad app can, at that moment.
- On a Mac, HomeKit works only in apps built the iPad way (Mac Catalyst). The Mac app is a native Mac app, so it would
  have no HomeKit at all.
- Sensor readings could come in only while the app is open, so Sensors would have gaps whenever it is closed.

How it would be built, within those limits:
- A Home screen on iPhone and iPad (Media or Body and home) listing rooms and accessories, with their state and a tap to
  switch them.
- Asking the assistant from the iPhone or iPad app while it is open: the app carries out a HomeKit action the assistant
  proposes, after your OK, the same way commands on your machines wait for approval.
- Turning on the HomeKit capability for the app's ID is quick (Xcode does it when the entitlement is added); the screen,
  the actions and the approval flow are the work, about the size of the Apple Calendar module.

Open question for the owner before building: whether an iPhone and iPad only Home screen, usable only while the app is
open, is worth it.
