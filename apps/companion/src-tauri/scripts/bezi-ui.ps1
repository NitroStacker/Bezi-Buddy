$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient

$processId = [int]$env:BEZI_REMOTE_BEZI_PID
$process = Get-Process -Id $processId -ErrorAction Stop
if ($process.MainWindowHandle -eq 0) {
    throw "The Bezi desktop window is not open."
}

$window = [System.Windows.Automation.AutomationElement]::FromHandle(
    [IntPtr]$process.MainWindowHandle
)
$buttonCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button
)
$treeItemCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::TreeItem
)
$groupCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Group
)

if (
    $env:BEZI_REMOTE_UI_ACTION -eq "expand-folder" -or
    $env:BEZI_REMOTE_UI_ACTION -eq "collapse-folder"
) {
    $itemId = $env:BEZI_REMOTE_UI_ITEM
    $treeItems = $window.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        $treeItemCondition
    )
    $target = $null
    foreach ($treeItem in $treeItems) {
        if ($treeItem.Current.Name -ceq $itemId) {
            $target = $treeItem
            break
        }
    }
    if ($null -eq $target) {
        throw "The requested Bezi folder is not visible."
    }
    try {
        $pattern = [System.Windows.Automation.ExpandCollapsePattern]$target.GetCurrentPattern(
            [System.Windows.Automation.ExpandCollapsePattern]::Pattern
        )
    }
    catch {
        throw "The requested Bezi item is not a folder."
    }
    $shouldExpand = $env:BEZI_REMOTE_UI_ACTION -eq "expand-folder"
    $isExpanded = (
        $pattern.Current.ExpandCollapseState -eq
        [System.Windows.Automation.ExpandCollapseState]::Expanded
    )
    if ($shouldExpand -ne $isExpanded) {
        $itemButtons = $target.FindAll(
            [System.Windows.Automation.TreeScope]::Descendants,
            $buttonCondition
        )
        if ($itemButtons.Count -eq 0) {
            throw "The requested Bezi folder cannot be opened."
        }
        $invokePattern = $itemButtons.Item(0).GetCurrentPattern(
            [System.Windows.Automation.InvokePattern]::Pattern
        )
        ([System.Windows.Automation.InvokePattern]$invokePattern).Invoke()
    }
    @{ ok = $true } | ConvertTo-Json -Compress
    exit 0
}

if ($env:BEZI_REMOTE_UI_ACTION -eq "activate") {
    $itemId = $env:BEZI_REMOTE_UI_ITEM
    $target = $null
    if ($itemId.StartsWith("nav:")) {
        $name = $itemId.Substring(4)
        $buttons = $window.FindAll(
            [System.Windows.Automation.TreeScope]::Descendants,
            $buttonCondition
        )
        foreach ($button in $buttons) {
            if ($button.Current.Name -ceq $name) {
                $target = $button
                break
            }
        }
    }
    else {
        $treeItems = $window.FindAll(
            [System.Windows.Automation.TreeScope]::Descendants,
            $treeItemCondition
        )
        foreach ($treeItem in $treeItems) {
            if ($treeItem.Current.Name -ceq $itemId) {
                $itemButtons = $treeItem.FindAll(
                    [System.Windows.Automation.TreeScope]::Descendants,
                    $buttonCondition
                )
                if ($itemButtons.Count -gt 0) {
                    $target = $itemButtons.Item(0)
                }
                break
            }
        }
    }
    if ($null -eq $target) {
        throw "The requested Bezi item is not visible."
    }
    $pattern = $target.GetCurrentPattern(
        [System.Windows.Automation.InvokePattern]::Pattern
    )
    ([System.Windows.Automation.InvokePattern]$pattern).Invoke()
    @{ ok = $true } | ConvertTo-Json -Compress
    exit 0
}

$projectIds = [Collections.Generic.HashSet[string]]::new(
    [StringComparer]::OrdinalIgnoreCase
)
foreach ($projectId in ($env:BEZI_REMOTE_PROJECT_IDS -split ",")) {
    if (-not [string]::IsNullOrWhiteSpace($projectId)) {
        [void]$projectIds.Add($projectId)
    }
}

$buttons = $window.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    $buttonCondition
)
$treeItems = $window.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    $treeItemCondition
)
$pageRows = [Collections.Generic.List[object]]::new()
$canvasRows = [Collections.Generic.List[object]]::new()
$visibleProjectIds = [Collections.Generic.List[string]]::new()
$navigation = [Collections.Generic.List[object]]::new()
$seenNavigation = [Collections.Generic.HashSet[string]]::new(
    [StringComparer]::Ordinal
)
$activeThreadTitle = $null
$navigationNames = @(
    "Your Rules",
    "Plans",
    "Canvases",
    "Shared Pages",
    "Private Pages"
)

foreach ($button in $buttons) {
    $name = $button.Current.Name
    $className = $button.Current.ClassName
    if (
        $className.StartsWith("grid grid-cols-[minmax(0,1fr)_auto]") -and
        -not [string]::IsNullOrWhiteSpace($name)
    ) {
        $activeThreadTitle = $name
    }
    if ($navigationNames -ccontains $name -and $seenNavigation.Add($name)) {
        $navigation.Add(@{ id = "nav:$name"; title = $name })
    }
}

foreach ($treeItem in $treeItems) {
    $id = $treeItem.Current.Name
    if ($id -notmatch "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$") {
        continue
    }
    if ($projectIds.Contains($id)) {
        $visibleProjectIds.Add($id)
        continue
    }
    $itemButtons = $treeItem.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        $buttonCondition
    )
    if ($itemButtons.Count -eq 0) {
        continue
    }
    $title = $itemButtons.Item(0).Current.Name
    if ([string]::IsNullOrWhiteSpace($title)) {
        continue
    }
    $isFolder = $false
    $expanded = $false
    try {
        $expandPattern = [System.Windows.Automation.ExpandCollapsePattern]$treeItem.GetCurrentPattern(
            [System.Windows.Automation.ExpandCollapsePattern]::Pattern
        )
        $isFolder = $true
        $expanded = (
            $expandPattern.Current.ExpandCollapseState -eq
            [System.Windows.Automation.ExpandCollapseState]::Expanded
        )
    }
    catch {
        $isFolder = $false
    }
    $indent = $treeItem.Current.BoundingRectangle.Left
    $groups = $treeItem.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        $groupCondition
    )
    foreach ($group in $groups) {
        if ($group.Current.ClassName.StartsWith("flex items-center w-full")) {
            $indent = $group.Current.BoundingRectangle.Left
            break
        }
    }
    $item = @{
        id = $id
        title = $title
        kind = $(if ($isFolder) { "folder" } else { "page" })
        expanded = $expanded
        indent = [double]$indent
    }
    if (
        -not $isFolder -and
        (Test-Path -LiteralPath (Join-Path $env:BEZI_REMOTE_CANVAS_ROOT $id) -PathType Container)
    ) {
        $item.kind = "canvas"
        $canvasRows.Add($item)
    }
    else {
        $pageRows.Add($item)
    }
}

$pages = [Collections.Generic.List[object]]::new()
$pageIndents = @($pageRows | ForEach-Object { $_.indent } | Sort-Object -Unique)
foreach ($item in $pageRows) {
    $depth = [Array]::IndexOf($pageIndents, $item.indent)
    $item.depth = $(if ($depth -ge 0) { $depth } else { 0 })
    [void]$item.Remove("indent")
    $pages.Add($item)
}

$canvases = [Collections.Generic.List[object]]::new()
$canvasIndents = @($canvasRows | ForEach-Object { $_.indent } | Sort-Object -Unique)
foreach ($item in $canvasRows) {
    $depth = [Array]::IndexOf($canvasIndents, $item.indent)
    $item.depth = $(if ($depth -ge 0) { $depth } else { 0 })
    [void]$item.Remove("indent")
    $canvases.Add($item)
}

@{
    available = $true
    pages = $pages
    canvases = $canvases
    visibleProjectIds = $visibleProjectIds
    navigation = $navigation
    activeThreadTitle = $activeThreadTitle
} | ConvertTo-Json -Compress -Depth 6
