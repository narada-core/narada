function New-NaradaOverlayCloseBrush([byte]$Alpha, [byte]$Red, [byte]$Green, [byte]$Blue) {
    $brush = [Windows.Media.SolidColorBrush]::new([Windows.Media.Color]::FromArgb($Alpha, $Red, $Green, $Blue))
    $brush.Freeze()
    return $brush
}

function New-NaradaOverlayCloseButton([string]$Tip = 'Close') {
    $button = [Windows.Controls.Button]::new()
    $button.Content = [string][char]0x00D7
    $button.Width = 22
    $button.Height = 22
    $button.MinWidth = 22
    $button.Margin = [Windows.Thickness]::new(2, 0, 0, 0)
    $button.Padding = [Windows.Thickness]::new(0)
    $button.FontFamily = [Windows.Media.FontFamily]::new('Segoe UI')
    $button.FontSize = 15
    $button.FontWeight = 'Normal'
    $button.Foreground = New-NaradaOverlayCloseBrush 170 215 215 225
    $button.Background = [Windows.Media.Brushes]::Transparent
    $button.BorderBrush = [Windows.Media.Brushes]::Transparent
    $button.BorderThickness = [Windows.Thickness]::new(0)
    $button.FocusVisualStyle = $null
    $button.ToolTip = $Tip
    $button.Cursor = [Windows.Input.Cursors]::Hand
    $button.Opacity = 0.7

    $template = [Windows.Controls.ControlTemplate]::new([Windows.Controls.Button])
    $templateBorder = [Windows.FrameworkElementFactory]::new([Windows.Controls.Border])
    $templateBorder.SetValue([Windows.Controls.Border]::BackgroundProperty, [Windows.TemplateBindingExtension]::new([Windows.Controls.Button]::BackgroundProperty))
    $templateBorder.SetValue([Windows.Controls.Border]::BorderBrushProperty, [Windows.TemplateBindingExtension]::new([Windows.Controls.Button]::BorderBrushProperty))
    $templateBorder.SetValue([Windows.Controls.Border]::BorderThicknessProperty, [Windows.TemplateBindingExtension]::new([Windows.Controls.Button]::BorderThicknessProperty))
    $templateBorder.SetValue([Windows.Controls.Border]::CornerRadiusProperty, [Windows.CornerRadius]::new(4))
    $content = [Windows.FrameworkElementFactory]::new([Windows.Controls.ContentPresenter])
    $content.SetValue([Windows.Controls.ContentPresenter]::ContentProperty, [Windows.TemplateBindingExtension]::new([Windows.Controls.Button]::ContentProperty))
    $content.SetValue([Windows.Controls.ContentPresenter]::HorizontalAlignmentProperty, [Windows.HorizontalAlignment]::Center)
    $content.SetValue([Windows.Controls.ContentPresenter]::VerticalAlignmentProperty, [Windows.VerticalAlignment]::Center)
    $templateBorder.AppendChild($content)
    $template.VisualTree = $templateBorder
    $button.Template = $template
    $button.Add_MouseEnter({
        param($sender, $eventArgs)
        $sender.Background = New-NaradaOverlayCloseBrush 32 255 255 255
        $sender.Foreground = New-NaradaOverlayCloseBrush 255 255 255 255
        $sender.Opacity = 1
    })
    $button.Add_MouseLeave({
        param($sender, $eventArgs)
        $sender.Background = [Windows.Media.Brushes]::Transparent
        $sender.Foreground = New-NaradaOverlayCloseBrush 170 215 215 225
        $sender.Opacity = 0.7
    })
    return $button
}
