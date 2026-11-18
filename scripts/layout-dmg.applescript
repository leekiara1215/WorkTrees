on run {mountPath, appName, backgroundName}
	set volumeRoot to POSIX file mountPath as alias
	tell application "Finder"
		set installer to item volumeRoot
		open installer
		try
			set installerWindow to container window of installer
			tell installerWindow
				set current view to icon view
				set toolbar visible to false
				set statusbar visible to false
				set bounds to {120, 100, 888, 644}
			end tell
			set installerView to icon view options of installerWindow
			tell installerView
				set arrangement to not arranged
				set icon size to 88
				set text size to 13
				set label position to bottom
			end tell
			set backgroundFile to file (".background:" & backgroundName) of installer
			set background picture of installerView to backgroundFile
			set extension hidden of item appName of installer to true
			set position of item appName of installer to {188, 213}
			set position of item "Applications" of installer to {580, 213}
			delay 1
		on error errorMessage number errorNumber
			close container window of installer
			error errorMessage number errorNumber
		end try
		close installerWindow
	end tell
end run
