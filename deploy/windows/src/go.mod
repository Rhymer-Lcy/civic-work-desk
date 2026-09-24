// CivicWorkDesk Windows deployment runtime.
//
// Standard library only, on purpose. This module is built into four small executables that ship to
// ordinary users, so every line of it has to be reviewable and nothing may need a runtime install.
// Adding a dependency here would mean auditing a supply chain for a program whose whole job is to
// serve seven static files on the loopback interface.
module civicworkdesk/windows

go 1.27
