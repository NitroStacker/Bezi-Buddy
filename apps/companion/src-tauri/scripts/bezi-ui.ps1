$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
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

function Find-PageTreeItem {
    param([string]$ItemId)

    $nameCondition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::NameProperty,
        $ItemId
    )
    $condition = [System.Windows.Automation.AndCondition]::new(
        $treeItemCondition,
        $nameCondition
    )
    $target = $window.FindFirst(
        [System.Windows.Automation.TreeScope]::Descendants,
        $condition
    )
    if ($null -ne $target) {
        return $target
    }

    $dataGridCondition = [System.Windows.Automation.AndCondition]::new(
        [System.Windows.Automation.PropertyCondition]::new(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::DataGrid
        ),
        [System.Windows.Automation.PropertyCondition]::new(
            [System.Windows.Automation.AutomationElement]::NameProperty,
            "Pages"
        )
    )
    $pageList = $window.FindFirst(
        [System.Windows.Automation.TreeScope]::Descendants,
        $dataGridCondition
    )
    if ($null -eq $pageList) {
        return $null
    }
    try {
        $scroll = [System.Windows.Automation.ScrollPattern]$pageList.GetCurrentPattern(
            [System.Windows.Automation.ScrollPattern]::Pattern
        )
    }
    catch {
        return $null
    }
    if (-not $scroll.Current.VerticallyScrollable) {
        return $null
    }

    $scroll.SetScrollPercent(
        [System.Windows.Automation.ScrollPattern]::NoScroll,
        0
    )
    for ($attempt = 0; $attempt -lt 24; $attempt++) {
        Start-Sleep -Milliseconds 60
        $target = $window.FindFirst(
            [System.Windows.Automation.TreeScope]::Descendants,
            $condition
        )
        if ($null -ne $target) {
            return $target
        }
        $before = $scroll.Current.VerticalScrollPercent
        if ($before -ge 99) {
            break
        }
        $scroll.Scroll(
            [System.Windows.Automation.ScrollAmount]::NoAmount,
            [System.Windows.Automation.ScrollAmount]::LargeIncrement
        )
        Start-Sleep -Milliseconds 80
        if ($scroll.Current.VerticalScrollPercent -le $before) {
            break
        }
    }
    return $null
}

function Set-PageFolderExpanded {
    param(
        [System.Windows.Automation.AutomationElement]$Target,
        [bool]$Expanded
    )

    try {
        $pattern = [System.Windows.Automation.ExpandCollapsePattern]$Target.GetCurrentPattern(
            [System.Windows.Automation.ExpandCollapsePattern]::Pattern
        )
    }
    catch {
        throw "The requested Bezi item is not a folder."
    }
    $isExpanded = (
        $pattern.Current.ExpandCollapseState -eq
        [System.Windows.Automation.ExpandCollapseState]::Expanded
    )
    if ($Expanded -eq $isExpanded) {
        return
    }
    $itemButtons = $Target.FindAll(
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

function Invoke-BeziSelectionElement {
    param([System.Windows.Automation.AutomationElement]$Target)

    try {
        $pattern = [System.Windows.Automation.InvokePattern]$Target.GetCurrentPattern(
            [System.Windows.Automation.InvokePattern]::Pattern
        )
        ([System.Windows.Automation.InvokePattern]$pattern).Invoke()
        return
    }
    catch {
        try {
            $pattern = [System.Windows.Automation.SelectionItemPattern]$Target.GetCurrentPattern(
                [System.Windows.Automation.SelectionItemPattern]::Pattern
            )
            ([System.Windows.Automation.SelectionItemPattern]$pattern).Select()
            return
        }
        catch {
            throw "The requested Bezi selection cannot be opened."
        }
    }
}

function Open-BeziSelectionMenu {
    param([System.Windows.Automation.AutomationElement]$Selector)

    try {
        $pattern = [System.Windows.Automation.ExpandCollapsePattern]$Selector.GetCurrentPattern(
            [System.Windows.Automation.ExpandCollapsePattern]::Pattern
        )
        if (
            $pattern.Current.ExpandCollapseState -eq
            [System.Windows.Automation.ExpandCollapseState]::Expanded
        ) {
            return
        }
    }
    catch {
        # Some Bezi selectors expose only InvokePattern. The lookup before this
        # call keeps an already-open menu from being toggled closed.
    }
    Invoke-BeziSelectionElement -Target $Selector
    Start-Sleep -Milliseconds 180
}

function Close-BeziSelectionMenu {
    param([System.Windows.Automation.AutomationElement]$Selector)

    try {
        $pattern = [System.Windows.Automation.ExpandCollapsePattern]$Selector.GetCurrentPattern(
            [System.Windows.Automation.ExpandCollapsePattern]::Pattern
        )
        if (
            $pattern.Current.ExpandCollapseState -eq
            [System.Windows.Automation.ExpandCollapseState]::Expanded
        ) {
            $pattern.Collapse()
            Start-Sleep -Milliseconds 100
        }
    }
    catch {
        # Closing is best-effort for selectors that expose only InvokePattern.
    }
}

function Test-BeziElementContainsLabel {
    param(
        [System.Windows.Automation.AutomationElement]$Target,
        [string]$Label
    )

    if ([string]::IsNullOrWhiteSpace($Label)) {
        return $false
    }
    if (
        [string]::Equals(
            $Target.Current.Name,
            $Label,
            [StringComparison]::OrdinalIgnoreCase
        )
    ) {
        return $true
    }
    $descendants = $Target.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition
    )
    foreach ($descendant in $descendants) {
        if (
            -not $descendant.Current.IsOffscreen -and
            [string]::Equals(
                $descendant.Current.Name,
                $Label,
                [StringComparison]::OrdinalIgnoreCase
            )
        ) {
            return $true
        }
    }
    return $false
}

function Test-BeziInvokePattern {
    param([System.Windows.Automation.AutomationElement]$Target)

    if (-not $Target.Current.IsEnabled -or $Target.Current.IsOffscreen) {
        return $false
    }
    try {
        [void]$Target.GetCurrentPattern(
            [System.Windows.Automation.InvokePattern]::Pattern
        )
        return $true
    }
    catch {
        return $false
    }
}

function Test-BeziSelectionItemPattern {
    param([System.Windows.Automation.AutomationElement]$Target)

    if (-not $Target.Current.IsEnabled -or $Target.Current.IsOffscreen) {
        return $false
    }
    try {
        [void]$Target.GetCurrentPattern(
            [System.Windows.Automation.SelectionItemPattern]::Pattern
        )
        return $true
    }
    catch {
        return $false
    }
}

function Find-BeziActionableDescendant {
    param([System.Windows.Automation.AutomationElement]$Target)

    if (Test-BeziInvokePattern -Target $Target) {
        return $Target
    }
    $descendants = $Target.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition
    )
    foreach ($descendant in $descendants) {
        if (Test-BeziInvokePattern -Target $descendant) {
            return $descendant
        }
    }
    if (Test-BeziSelectionItemPattern -Target $Target) {
        return $Target
    }
    foreach ($descendant in $descendants) {
        if (Test-BeziSelectionItemPattern -Target $descendant) {
            return $descendant
        }
    }
    return $null
}

function Find-BeziSelectionElement {
    param(
        [string[]]$Identifiers,
        [string]$Label,
        [System.Windows.Automation.AutomationElement]$Exclude
    )

    $elements = $window.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition
    )
    $labelMatch = $null
    foreach ($element in $elements) {
        if ($null -ne $Exclude -and $element -eq $Exclude) {
            continue
        }

        $automationId = $element.Current.AutomationId
        $name = $element.Current.Name
        foreach ($identifier in $Identifiers) {
            if (
                -not [string]::IsNullOrWhiteSpace($identifier) -and
                (
                    [string]::Equals(
                        $name,
                        $identifier,
                        [StringComparison]::OrdinalIgnoreCase
                    ) -or
                    (
                        -not [string]::IsNullOrWhiteSpace($automationId) -and
                        $automationId.IndexOf(
                            $identifier,
                            [StringComparison]::OrdinalIgnoreCase
                        ) -ge 0
                    )
                )
            ) {
                $target = Find-BeziActionableDescendant -Target $element
                if ($null -ne $target) {
                    return $target
                }
            }
        }
        if (
            $null -eq $labelMatch -and
            -not [string]::IsNullOrWhiteSpace($Label) -and
            -not [string]::IsNullOrWhiteSpace($name) -and
            (
                [string]::Equals(
                    $name,
                    $Label,
                    [StringComparison]::OrdinalIgnoreCase
                ) -or
                $name.StartsWith(
                    "$Label ",
                    [StringComparison]::OrdinalIgnoreCase
                )
            )
        ) {
            $labelMatch = Find-BeziActionableDescendant -Target $element
        }
    }
    return $labelMatch
}

function Find-BeziSelectionElementWithScroll {
    param(
        [string[]]$Identifiers,
        [string]$Label,
        [System.Windows.Automation.AutomationElement]$Exclude,
        [System.Windows.Automation.AutomationElement]$Selector
    )

    $target = Find-BeziSelectionElement `
        -Identifiers $Identifiers `
        -Label $Label `
        -Exclude $Exclude
    if ($null -ne $target) {
        return $target
    }

    $selectorRectangle = $Selector.Current.BoundingRectangle
    $selectorCenterX = $selectorRectangle.Left + ($selectorRectangle.Width / 2)
    $elements = $window.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition
    )
    foreach ($element in $elements) {
        if ($element.Current.IsOffscreen) {
            continue
        }
        $rectangle = $element.Current.BoundingRectangle
        if (
            $rectangle.Width -lt 100 -or
            $rectangle.Height -lt 80 -or
            $rectangle.Left -gt $selectorCenterX -or
            $rectangle.Right -lt $selectorCenterX -or
            $rectangle.Bottom -le $selectorRectangle.Bottom
        ) {
            continue
        }
        try {
            $scroll = [System.Windows.Automation.ScrollPattern]$element.GetCurrentPattern(
                [System.Windows.Automation.ScrollPattern]::Pattern
            )
        }
        catch {
            continue
        }
        if (-not $scroll.Current.VerticallyScrollable) {
            continue
        }

        try {
            $scroll.SetScrollPercent(
                [System.Windows.Automation.ScrollPattern]::NoScroll,
                0
            )
        }
        catch {
            # Some virtualized selectors support increments but not percentages.
        }
        for ($attempt = 0; $attempt -lt 48; $attempt++) {
            Start-Sleep -Milliseconds 60
            $target = Find-BeziSelectionElement `
                -Identifiers $Identifiers `
                -Label $Label `
                -Exclude $Exclude
            if ($null -ne $target) {
                return $target
            }
            $before = $scroll.Current.VerticalScrollPercent
            if ($before -ge 99) {
                break
            }
            try {
                $scroll.Scroll(
                    [System.Windows.Automation.ScrollAmount]::NoAmount,
                    [System.Windows.Automation.ScrollAmount]::LargeIncrement
                )
            }
            catch {
                break
            }
            Start-Sleep -Milliseconds 60
            if ($scroll.Current.VerticalScrollPercent -le $before) {
                break
            }
        }
    }
    return $null
}

function Set-BeziWorkspace {
    param(
        [string]$WorkspaceId,
        [string]$WorkspaceLabel
    )

    $buttons = $window.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        $buttonCondition
    )
    $selector = $null
    $windowRectangle = $window.Current.BoundingRectangle
    foreach ($button in $buttons) {
        $rectangle = $button.Current.BoundingRectangle
        if (
            -not $button.Current.IsOffscreen -and
            $rectangle.Width -gt 120 -and
            $rectangle.Height -gt 20 -and
            $rectangle.Left -lt ($windowRectangle.Left + 360) -and
            $rectangle.Top -gt ($windowRectangle.Top + 55) -and
            $rectangle.Top -lt ($windowRectangle.Top + 170)
        ) {
            $selector = $button
            break
        }
    }
    if ($null -eq $selector) {
        throw "The Bezi workspace selector is not visible."
    }
    if (Test-BeziElementContainsLabel -Target $selector -Label $WorkspaceLabel) {
        Close-BeziSelectionMenu -Selector $selector
        return
    }
    $target = Find-BeziSelectionElement `
        -Identifiers @($WorkspaceId) `
        -Label $WorkspaceLabel `
        -Exclude $selector
    if ($null -eq $target) {
        Open-BeziSelectionMenu -Selector $selector
        $target = Find-BeziSelectionElementWithScroll `
            -Identifiers @($WorkspaceId) `
            -Label $WorkspaceLabel `
            -Exclude $selector `
            -Selector $selector
    }
    if ($null -eq $target) {
        throw "The requested Bezi workspace is not available in the selector."
    }
    Invoke-BeziSelectionElement -Target $target
    Start-Sleep -Milliseconds 220
}

if ($env:BEZI_REMOTE_UI_ACTION -eq "activate-workspace") {
    Set-BeziWorkspace `
        -WorkspaceId $env:BEZI_REMOTE_UI_ITEM `
        -WorkspaceLabel $env:BEZI_REMOTE_UI_LABEL
    @{ ok = $true } | ConvertTo-Json -Compress
    exit 0
}

if ($env:BEZI_REMOTE_UI_ACTION -eq "activate-thread") {
    if (-not [string]::IsNullOrWhiteSpace($env:BEZI_REMOTE_UI_WORKSPACE)) {
        Set-BeziWorkspace `
            -WorkspaceId $env:BEZI_REMOTE_UI_WORKSPACE `
            -WorkspaceLabel $env:BEZI_REMOTE_UI_WORKSPACE_LABEL
    }

    $buttons = $window.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        $buttonCondition
    )
    $selector = $null
    foreach ($button in $buttons) {
        if ($button.Current.ClassName.StartsWith("grid grid-cols-[minmax(0,1fr)_auto]")) {
            $selector = $button
            break
        }
    }
    if ($null -eq $selector) {
        throw "The Bezi thread selector is not visible."
    }
    $target = Find-BeziSelectionElement `
        -Identifiers @($env:BEZI_REMOTE_UI_ITEM, $env:BEZI_REMOTE_UI_SESSION) `
        -Label $env:BEZI_REMOTE_UI_LABEL `
        -Exclude $selector
    if ($null -eq $target) {
        Open-BeziSelectionMenu -Selector $selector
        $target = Find-BeziSelectionElementWithScroll `
            -Identifiers @($env:BEZI_REMOTE_UI_ITEM, $env:BEZI_REMOTE_UI_SESSION) `
            -Label $env:BEZI_REMOTE_UI_LABEL `
            -Exclude $selector `
            -Selector $selector
    }
    if ($null -eq $target) {
        throw "The requested Bezi thread is not available in the selector."
    }
    Invoke-BeziSelectionElement -Target $target
    @{ ok = $true } | ConvertTo-Json -Compress
    exit 0
}

if (
    $env:BEZI_REMOTE_UI_ACTION -eq "expand-folder" -or
    $env:BEZI_REMOTE_UI_ACTION -eq "collapse-folder"
) {
    $itemId = $env:BEZI_REMOTE_UI_ITEM
    $target = Find-PageTreeItem -ItemId $itemId
    if ($null -eq $target) {
        throw "The requested Bezi folder is not visible."
    }
    $shouldExpand = $env:BEZI_REMOTE_UI_ACTION -eq "expand-folder"
    Set-PageFolderExpanded -Target $target -Expanded $shouldExpand
    @{ ok = $true } | ConvertTo-Json -Compress
    exit 0
}

if (
    $env:BEZI_REMOTE_UI_ACTION -eq "activate" -or
    $env:BEZI_REMOTE_UI_ACTION -eq "read-page"
) {
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
        if ($env:BEZI_REMOTE_UI_ACTION -eq "read-page") {
            foreach ($ancestorId in ($env:BEZI_REMOTE_UI_ANCESTORS -split ",")) {
                if ([string]::IsNullOrWhiteSpace($ancestorId)) {
                    continue
                }
                $ancestor = Find-PageTreeItem -ItemId $ancestorId
                if ($null -eq $ancestor) {
                    throw "A containing Bezi page folder is not visible."
                }
                Set-PageFolderExpanded -Target $ancestor -Expanded $true
                Start-Sleep -Milliseconds 100
            }
        }
        $treeItem = Find-PageTreeItem -ItemId $itemId
        if ($null -ne $treeItem) {
            $itemButtons = $treeItem.FindAll(
                [System.Windows.Automation.TreeScope]::Descendants,
                $buttonCondition
            )
            if ($itemButtons.Count -gt 0) {
                $target = $itemButtons.Item(0)
            }
        }
    }
    if ($null -eq $target) {
        throw "The requested Bezi item is not visible."
    }
    if ($env:BEZI_REMOTE_UI_ACTION -eq "read-page") {
        $title = $target.Current.Name
        if ([string]::IsNullOrWhiteSpace($title)) {
            throw "The requested Bezi page has no readable title."
        }

        $editCondition = [System.Windows.Automation.PropertyCondition]::new(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::Edit
        )
        $alreadyLoaded = $false
        $currentEditors = $window.FindAll(
            [System.Windows.Automation.TreeScope]::Descendants,
            $editCondition
        )
        foreach ($editor in $currentEditors) {
            if (-not $editor.Current.ClassName.StartsWith("bg-transparent text-[36px]")) {
                continue
            }
            try {
                $valuePattern = [System.Windows.Automation.ValuePattern]$editor.GetCurrentPattern(
                    [System.Windows.Automation.ValuePattern]::Pattern
                )
                if ($valuePattern.Current.Value -ceq $title) {
                    $alreadyLoaded = $true
                    break
                }
            }
            catch {
                continue
            }
        }
        if (-not $alreadyLoaded) {
            $pattern = $target.GetCurrentPattern(
                [System.Windows.Automation.InvokePattern]::Pattern
            )
            ([System.Windows.Automation.InvokePattern]$pattern).Invoke()
        }

        $paragraphs = $null
        for ($attempt = 0; $attempt -lt 24; $attempt++) {
            Start-Sleep -Milliseconds 100
            $editors = $window.FindAll(
                [System.Windows.Automation.TreeScope]::Descendants,
                $editCondition
            )

            $loadedTitle = $false
            $contentEditor = $null
            foreach ($editor in $editors) {
                $className = $editor.Current.ClassName
                if ($className -ceq "tiptap ProseMirror") {
                    $contentEditor = $editor
                    continue
                }
                if ($className.StartsWith("bg-transparent text-[36px]")) {
                    try {
                        $valuePattern = [System.Windows.Automation.ValuePattern]$editor.GetCurrentPattern(
                            [System.Windows.Automation.ValuePattern]::Pattern
                        )
                        if ($valuePattern.Current.Value -ceq $title) {
                            $loadedTitle = $true
                        }
                    }
                    catch {
                        continue
                    }
                }
            }
            if (-not $loadedTitle -or $null -eq $contentEditor) {
                continue
            }
            try {
                $textPattern = [System.Windows.Automation.TextPattern]$contentEditor.GetCurrentPattern(
                    [System.Windows.Automation.TextPattern]::Pattern
                )
                $range = $textPattern.DocumentRange.Clone()
            }
            catch {
                continue
            }

            $paragraphs = [Collections.Generic.List[object]]::new()
            $documentEnd = $textPattern.DocumentRange.Clone()
            for ($index = 0; $index -lt 8000; $index++) {
                $range.ExpandToEnclosingUnit(
                    [System.Windows.Automation.Text.TextUnit]::Paragraph
                )
                $text = $range.GetText(-1)
                $text = $text.Replace([char]0xfffc, " ")
                $text = ($text -replace "[\r\n]+", " " -replace "\s+", " ").Trim()
                if (-not [string]::IsNullOrWhiteSpace($text)) {
                    $firstCharacter = $range.Clone()
                    $firstCharacter.MoveEndpointByRange(
                        [System.Windows.Automation.Text.TextPatternRangeEndpoint]::End,
                        $firstCharacter,
                        [System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start
                    )
                    [void]$firstCharacter.MoveEndpointByUnit(
                        [System.Windows.Automation.Text.TextPatternRangeEndpoint]::End,
                        [System.Windows.Automation.Text.TextUnit]::Character,
                        1
                    )
                    $fontSize = $firstCharacter.GetAttributeValue(
                        [System.Windows.Automation.TextPattern]::FontSizeAttribute
                    )
                    if ($fontSize -isnot [double] -and $fontSize -isnot [int]) {
                        $fontSize = 0
                    }
                    $paragraphs.Add(@{
                        text = $text
                        fontSize = [double]$fontSize
                    })
                }
                if (
                    $range.CompareEndpoints(
                        [System.Windows.Automation.Text.TextPatternRangeEndpoint]::End,
                        $documentEnd,
                        [System.Windows.Automation.Text.TextPatternRangeEndpoint]::End
                    ) -ge 0
                ) {
                    break
                }
                if (
                    $range.Move(
                        [System.Windows.Automation.Text.TextUnit]::Paragraph,
                        1
                    ) -eq 0
                ) {
                    break
                }
            }
            break
        }

        if ($null -eq $paragraphs) {
            throw "The requested Bezi page did not finish loading."
        }

        $markdown = [Collections.Generic.List[string]]::new()
        $pendingMarker = $null
        $pendingReference = $false
        for ($index = 0; $index -lt $paragraphs.Count; $index++) {
            $paragraph = $paragraphs[$index]
            $text = [string]$paragraph.text
            $fontSize = [double]$paragraph.fontSize

            if ($text -eq "@" -and $null -ne $pendingMarker) {
                $pendingReference = $true
                continue
            }
            $startsWithBullet =
                $text.Length -gt 0 -and [int]$text[0] -eq 0x2022
            if (
                ($startsWithBullet -and $text.Length -eq 1) -or
                $text -ceq "*" -or
                $text -ceq "-"
            ) {
                $pendingMarker = "-"
                $pendingReference = $false
                continue
            }
            if ($text -match "^(\d+)[.)]$") {
                $pendingMarker = "$($Matches[1])."
                $pendingReference = $false
                continue
            }
            if ($null -ne $pendingMarker) {
                $referencePrefix = $(if ($pendingReference) { "@ " } else { "" })
                $markdown.Add("$pendingMarker $referencePrefix$text")
                $pendingMarker = $null
                $pendingReference = $false
                continue
            }
            if ($startsWithBullet -and $text.Length -gt 1) {
                $markdown.Add("- $($text.Substring(1).Trim())")
                continue
            }
            if ($text -match "^\*\s*(.+)$") {
                $markdown.Add("- $($Matches[1])")
                continue
            }
            if ($fontSize -ge 21) {
                $markdown.Add("# $text")
            }
            elseif ($fontSize -ge 16) {
                $markdown.Add("## $text")
            }
            elseif ($fontSize -ge 13) {
                $markdown.Add("### $text")
            }
            else {
                $markdown.Add($text)
            }
        }

        $content = ($markdown -join "`n`n").Trim()
        $truncated = $false
        if ($content.Length -gt 750000) {
            $content = $content.Substring(0, 750000)
            $truncated = $true
        }
        @{
            pageId = $itemId
            title = $title
            markdown = $content
            truncated = $truncated
        } | ConvertTo-Json -Compress
        exit 0
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

function Convert-BeziPageTreeItem {
    param([System.Windows.Automation.AutomationElement]$TreeItem)

    $id = $TreeItem.Current.Name
    if ($id -notmatch "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$") {
        return $null
    }
    $itemButtons = $TreeItem.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        $buttonCondition
    )
    if ($itemButtons.Count -eq 0) {
        return $null
    }
    $title = $itemButtons.Item(0).Current.Name
    if ([string]::IsNullOrWhiteSpace($title)) {
        return $null
    }
    $isFolder = $false
    $expanded = $false
    try {
        $expandPattern = [System.Windows.Automation.ExpandCollapsePattern]$TreeItem.GetCurrentPattern(
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
    $indent = $TreeItem.Current.BoundingRectangle.Left
    $groups = $TreeItem.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        $groupCondition
    )
    foreach ($group in $groups) {
        if ($group.Current.ClassName.StartsWith("flex items-center w-full")) {
            $indent = $group.Current.BoundingRectangle.Left
            break
        }
    }
    $kind = $(if ($isFolder) { "folder" } else { "page" })
    if (
        -not $isFolder -and
        (Test-Path -LiteralPath (Join-Path $env:BEZI_REMOTE_CANVAS_ROOT $id) -PathType Container)
    ) {
        $kind = "canvas"
    }
    return @{
        id = $id
        title = $title
        kind = $kind
        expanded = $expanded
        indent = [double]$indent
    }
}

function Get-BeziPageScrollPattern {
    param([System.Windows.Automation.AutomationElement]$PageList)

    try {
        return [System.Windows.Automation.ScrollPattern]$PageList.GetCurrentPattern(
            [System.Windows.Automation.ScrollPattern]::Pattern
        )
    }
    catch {
        return $null
    }
}

function Get-BeziCompletePageTree {
    $emptyResult = @{
        complete = $false
        pageRows = [Collections.Generic.List[object]]::new()
        canvasRows = [Collections.Generic.List[object]]::new()
    }
    $dataGridCondition = [System.Windows.Automation.AndCondition]::new(
        [System.Windows.Automation.PropertyCondition]::new(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::DataGrid
        ),
        [System.Windows.Automation.PropertyCondition]::new(
            [System.Windows.Automation.AutomationElement]::NameProperty,
            "Pages"
        )
    )
    $pageList = $window.FindFirst(
        [System.Windows.Automation.TreeScope]::Descendants,
        $dataGridCondition
    )
    if ($null -eq $pageList) {
        return $emptyResult
    }
    $scroll = Get-BeziPageScrollPattern -PageList $pageList
    $originalScrollPercent = $(
        if ($null -ne $scroll) { $scroll.Current.VerticalScrollPercent } else { -1 }
    )
    $foldersExpandedByScan = [Collections.Generic.HashSet[string]]::new(
        [StringComparer]::OrdinalIgnoreCase
    )
    $folderIndents = @{}
    $finalPageRows = [Collections.Generic.List[object]]::new()
    $finalCanvasRows = [Collections.Generic.List[object]]::new()
    $complete = $false
    try {
        for ($pass = 0; $pass -lt 16; $pass++) {
            $scroll = Get-BeziPageScrollPattern -PageList $pageList
            $pageRows = [Collections.Generic.List[object]]::new()
            $canvasRows = [Collections.Generic.List[object]]::new()
            $seen = [Collections.Generic.HashSet[string]]::new(
                [StringComparer]::OrdinalIgnoreCase
            )
            $expandedAny = $false
            if ($null -ne $scroll -and $scroll.Current.VerticallyScrollable) {
                $scroll.SetScrollPercent(
                    [System.Windows.Automation.ScrollPattern]::NoScroll,
                    0
                )
                Start-Sleep -Milliseconds 80
            }

            for ($scrollAttempt = 0; $scrollAttempt -lt 64; $scrollAttempt++) {
                $treeItemsAtPosition = @(
                    $pageList.FindAll(
                        [System.Windows.Automation.TreeScope]::Descendants,
                        $treeItemCondition
                    ) |
                        Sort-Object `
                            { $_.Current.BoundingRectangle.Top }, `
                            { $_.Current.BoundingRectangle.Left }
                )
                foreach ($treeItem in $treeItemsAtPosition) {
                    if ($treeItem.Current.IsOffscreen) {
                        continue
                    }
                    $item = Convert-BeziPageTreeItem -TreeItem $treeItem
                    if ($null -eq $item -or -not $seen.Add([string]$item.id)) {
                        continue
                    }
                    if ($item.kind -eq "folder") {
                        $folderIndents[[string]$item.id] = [double]$item.indent
                        if (-not $item.expanded) {
                            if ($foldersExpandedByScan.Add([string]$item.id)) {
                                Set-PageFolderExpanded -Target $treeItem -Expanded $true
                                Start-Sleep -Milliseconds 60
                            }
                            $expandedAny = $true
                        }
                    }
                    if ($item.kind -eq "canvas") {
                        $canvasRows.Add($item)
                    }
                    else {
                        $pageRows.Add($item)
                    }
                }

                if ($null -eq $scroll -or -not $scroll.Current.VerticallyScrollable) {
                    break
                }
                $before = $scroll.Current.VerticalScrollPercent
                if ($before -ge 99) {
                    break
                }
                $scroll.Scroll(
                    [System.Windows.Automation.ScrollAmount]::NoAmount,
                    [System.Windows.Automation.ScrollAmount]::LargeIncrement
                )
                Start-Sleep -Milliseconds 80
                if ($scroll.Current.VerticalScrollPercent -le $before) {
                    break
                }
            }

            if (-not $expandedAny) {
                $finalPageRows = $pageRows
                $finalCanvasRows = $canvasRows
                $complete = $true
                break
            }
        }
    }
    finally {
        $orderedFolderIds = @(
            $foldersExpandedByScan |
                Sort-Object { [double]$folderIndents[[string]$_] } -Descending
        )
        foreach ($folderId in $orderedFolderIds) {
            $target = Find-PageTreeItem -ItemId $folderId
            if ($null -ne $target) {
                try {
                    Set-PageFolderExpanded -Target $target -Expanded $false
                    Start-Sleep -Milliseconds 40
                }
                catch {
                    # Restoring the user's collapsed state is best-effort.
                }
            }
        }
        foreach ($item in $finalPageRows) {
            if ($foldersExpandedByScan.Contains([string]$item.id)) {
                $item.expanded = $false
            }
        }
        $scroll = Get-BeziPageScrollPattern -PageList $pageList
        if (
            $null -ne $scroll -and
            $scroll.Current.VerticallyScrollable -and
            $originalScrollPercent -ge 0
        ) {
            try {
                $scroll.SetScrollPercent(
                    [System.Windows.Automation.ScrollPattern]::NoScroll,
                    $originalScrollPercent
                )
            }
            catch {
                # Restoring the user's scroll position is best-effort.
            }
        }
    }

    return @{
        complete = $complete
        pageRows = $finalPageRows
        canvasRows = $finalCanvasRows
    }
}

$completePageTree = $null
if ($env:BEZI_REMOTE_UI_COMPLETE_PAGES -eq "1") {
    $completePageTree = Get-BeziCompletePageTree
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
    if ($null -ne $completePageTree -and $completePageTree.complete) {
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

if ($null -ne $completePageTree -and $completePageTree.complete) {
    $pageRows = $completePageTree.pageRows
    $canvasRows = $completePageTree.canvasRows
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
    pagesComplete = $null -ne $completePageTree -and $completePageTree.complete
    pages = $pages
    canvases = $canvases
    visibleProjectIds = $visibleProjectIds
    navigation = $navigation
    activeThreadTitle = $activeThreadTitle
} | ConvertTo-Json -Compress -Depth 6
