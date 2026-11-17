#!/usr/bin/env python3
"""Erzeugt die leere Excel-Vorlage der Monatsabrechnung (Temporäre Dolmetscher/innen).

Aufbau wie die abgestimmte Vorlage „September Temporär 2026“ – nur ohne Daten und mit
mehr Platz (40 Personen, 60 Sondertage, 300 Belege). Das Programm füllt beim Herunterladen
nur Werte ein (Monat, Prüfdatum, Tagessatz, Namen, Arbeitstage, Sondertage, Belege);
alle Formeln rechnen in Excel weiter.

Aufruf:  python3 vorlage_erstellen.py Monatsabrechnung-Temporaer.xlsx   (braucht openpyxl)
"""
import sys
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Border, Side, Alignment
from openpyxl.worksheet.table import Table, TableStyleInfo, TableColumn, TableFormula
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.formatting.rule import FormulaRule, CellIsRule
from openpyxl.workbook.defined_name import DefinedName
from openpyxl.worksheet.formula import ArrayFormula
from openpyxl.worksheet.hyperlink import Hyperlink
from openpyxl.utils import get_column_letter

OUT = sys.argv[1] if len(sys.argv) > 1 else 'Monatsabrechnung-Temporaer.xlsx'

# Größen (Datenzeilen)
N_END = 40      # Endliste: Personen
N_SONDER = 60   # Sondertage
N_DOLM = 40     # Übersicht: Dolmetscher/innen
N_BELEGE = 300  # Belege
N_BUCH = 40     # Übersicht Buchhaltung: Zeilen
N_ABR = 40      # Abrechnung je Person: Zeilen

# Farben
NAVY, TEXT, GREY, MUTE, LINK, WHITE, AMBER = '1F3A5F', '1F2937', '374151', '6B7280', '2E75B6', 'FFFFFF', '9A5B00'
F_YELLOW, F_LIGHT, F_MUTE = 'FFF4CC', 'F3F6FA', '6B7280'
B_ROW, B_ROW2, B_INPUT, B_NAVY, B_TEXT = 'D9DEE7', 'B8C1CE', 'D6B656', '1F3A5F', '1F2937'

EURO = '#,##0.00 "€";-#,##0.00 "€";"–"'
EURO_BLANK = '#,##0.00 "€";-#,##0.00 "€";""'
INT = '0'
INT_DASH = '0;-0;"–"'
DATE = 'dd.mm.yyyy'
DATE_BLANK = 'dd.mm.yyyy;;'
DATE_DDD = '[$-407]ddd, dd.mm.yyyy'


def font(size=10, bold=False, color=TEXT):
    return Font(name='Arial', size=size, bold=bold, color=color)


def fill(color):
    return PatternFill('solid', fgColor=color) if color else PatternFill()


def side(color, style='thin'):
    return Side(style=style, color=color)


def border(l=None, r=None, t=None, b=None):
    return Border(left=l or Side(), right=r or Side(), top=t or Side(), bottom=b or Side())


def put(ws, coord, value=None, f=None, bg=None, fmt=None, h=None, v='center', wrap=None, bd=None):
    cell = ws[coord]
    if value is not None:
        cell.value = value
    cell.font = f or font()
    if bg:
        cell.fill = fill(bg)
    if fmt:
        cell.number_format = fmt
    cell.alignment = Alignment(horizontal=h, vertical=v, wrap_text=wrap)
    if bd:
        cell.border = bd
    return cell


def link(ws, coord, text, target, h='left', size=10):
    cell = put(ws, coord, text, font(size, True, LINK), h=h)
    cell.hyperlink = Hyperlink(ref=coord, location=target)
    return cell


def widths(ws, mapping):
    for col, width in mapping.items():
        ws.column_dimensions[col].width = width


def heights(ws, mapping):
    for row, height in mapping.items():
        ws.row_dimensions[row].height = height


def header_row(ws, row, labels, aligns, wrap=False, size=11):
    for col, (label, align) in enumerate(zip(labels, aligns), start=2):
        put(ws, f'{get_column_letter(col)}{row}', label, font(size, True, WHITE), NAVY, h=align, wrap=wrap or None)


def setup_sheet(ws, tab, orientation, fit_height, print_area, left=0.5, top=0.6, title_rows=None):
    ws.sheet_properties.tabColor = tab
    ws.sheet_view.showGridLines = False
    ws.page_setup.orientation = orientation
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = fit_height
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.print_options.horizontalCentered = True
    ws.page_margins.left = left
    ws.page_margins.right = left
    ws.page_margins.top = top
    ws.page_margins.bottom = top
    if print_area:
        ws.print_area = print_area
    if title_rows:
        ws.print_title_rows = title_rows


def add_table(ws, name, ref, columns, totals=False):
    table = Table(displayName=name, ref=ref)
    table.tableStyleInfo = TableStyleInfo(name=None, showFirstColumn=False, showLastColumn=False, showRowStripes=False, showColumnStripes=False)
    if totals:
        table.totalsRowCount = 1
        table.totalsRowShown = True
    cols = []
    for index, spec in enumerate(columns, start=1):
        col = TableColumn(id=index, name=spec['name'])
        if spec.get('calc'):
            col.calculatedColumnFormula = TableFormula(attr_text=spec['calc'])
        if spec.get('total'):
            col.totalsRowFunction = spec['total']
        if spec.get('totalFormula'):
            col.totalsRowFormula = TableFormula(attr_text=spec['totalFormula'])
        if spec.get('totalLabel'):
            col.totalsRowLabel = spec['totalLabel']
        cols.append(col)
    table.tableColumns = cols
    table.autoFilter = None
    ws.add_table(table)


wb = Workbook()
wb.remove(wb.active)
ws_end = wb.create_sheet('Endliste')
ws_son = wb.create_sheet('Sondertage')
ws_ueb = wb.create_sheet('Übersicht')
ws_buch = wb.create_sheet('Übersicht Buchhaltung')
ws_bel = wb.create_sheet('Belege')
ws_abr = wb.create_sheet('Abrechnung')
ws_lst = wb.create_sheet('Listen')

# ======================================================================= Endliste
ws = ws_end
END_FIRST, END_LAST = 9, 8 + N_END
END_TOTAL = END_LAST + 1
setup_sheet(ws, 'C2410C', 'portrait', 1, f"'Endliste'!$B$2:$G${END_TOTAL + 5}", left=0.3, top=0.45, title_rows='8:8')
widths(ws, {'A': 2.0, 'B': 13.0, 'C': 12.5, 'D': 29.0, 'E': 14.5, 'F': 14.5, 'G': 15.5, 'H': 12.5, 'I': 36.0, 'J': 3.0, 'K': 62.0})
heights(ws, {1: 24.0, 2: 28.0, 3: 18.0, 4: 8.0, 5: 24.0, 6: 16.0, 7: 8.0, 8: 32.0})
for col in 'BCDEFGHI':
    put(ws, f'{col}1', None, font(10, col == 'B', TEXT), F_LIGHT, v=None)
put(ws, 'B1', '=E_Meldung', font(10, True, TEXT), F_LIGHT)
put(ws, 'B2', 'Endliste · Temporäre Dolmetscher/innen', font(18, True, NAVY))
link(ws, 'K2', '← zur Übersicht (Monat, Prüfdatum)', "'Übersicht'!C5")
put(ws, 'B3', '="Arbeitstage und Parkgebühren · "&Abr_Text&" · Zeitraum "&Abr_Zeitraum', font(11), v=None)
link(ws, 'K3', '→ Sondertage bearbeiten', "'Sondertage'!B7")
put(ws, 'B5', 'Tagessatz', font(11, True))
put(ws, 'C5', 80, font(12, True), F_YELLOW, EURO, h='center', bd=border(side(B_INPUT), side(B_INPUT), side(B_INPUT), side(B_INPUT)))
put(ws, 'D5', 'Salary = (Arbeitstage − Sondertage) × Tagessatz + Beträge der Sondertage', font(10))
put(ws, 'K5', "So geht's", font(10, True, NAVY))
put(ws, 'B6', 'Grün hinterlegt = Dolmetscher/in mit besonders bezahlten Tagen (siehe Spalte „Sondertage“)', font(10, color=GREY))
put(ws, 'K6', '1  Arbeitstage = Zahl oben auf dem Tagesblatt (z. B. „18T“).', font(10, color=GREY))
put(ws, 'K7', '2  Besondere Tage im Blatt „Sondertage“ eintragen – erscheinen hier grün.', font(10, color=GREY))
put(ws, 'K8', '3  Parkgebühren kommen automatisch aus dem Blatt „Belege“.', font(10, color=GREY))
put(ws, 'K9', '4  Neue Person: Tab-Taste in der letzten Tabellenzelle, Name per ▼.', font(10, color=GREY))
put(ws, 'K10', 'Datum unten = Prüfdatum aus der Übersicht.', font(10, color=MUTE))
header_row(ws, 8, ['Name of Employee', 'Arbeitstage', 'Sondertage', 'Parkgebühr', 'Salary', 'Total Amount', 'davon Sondertage', 'Bemerkung'],
           ['left', 'center', 'left', 'right', 'right', 'right', 'center', 'left'], wrap=True)
F_SONDER = ('=IFERROR(INDEX(tblSonder[Kurztext],_xlfn.AGGREGATE(15,6,(ROW(tblSonder[Name])-ROW(tblSonder[#Headers]))/((tblSonder[Name]=tblEndliste[[#This Row],[Name of Employee]])*(tblSonder[Kurztext]<>"")),1)),"")'
            '&IFERROR(" · "&INDEX(tblSonder[Kurztext],_xlfn.AGGREGATE(15,6,(ROW(tblSonder[Name])-ROW(tblSonder[#Headers]))/((tblSonder[Name]=tblEndliste[[#This Row],[Name of Employee]])*(tblSonder[Kurztext]<>"")),2)),"")'
            '&IFERROR(" · "&INDEX(tblSonder[Kurztext],_xlfn.AGGREGATE(15,6,(ROW(tblSonder[Name])-ROW(tblSonder[#Headers]))/((tblSonder[Name]=tblEndliste[[#This Row],[Name of Employee]])*(tblSonder[Kurztext]<>"")),3)),"")')
F_PARK = '=SUMIFS(tblBelege[Betrag],tblBelege[Name],tblEndliste[[#This Row],[Name of Employee]])'
F_SALARY = '=(tblEndliste[[#This Row],[Arbeitstage]]-tblEndliste[[#This Row],[davon Sondertage]])*Tagessatz+SUMIFS(tblSonder[Betrag für den Tag],tblSonder[Name],tblEndliste[[#This Row],[Name of Employee]],tblSonder[Zählt],"Ja")'
F_TOTAL = '=tblEndliste[[#This Row],[Parkgebühr]]+tblEndliste[[#This Row],[Salary]]'
F_COUNT = '=COUNTIFS(tblSonder[Name],tblEndliste[[#This Row],[Name of Employee]],tblSonder[Zählt],"Ja")'
row_bd = border(b=side(B_ROW2))
for r in range(END_FIRST, END_LAST + 1):
    ws.row_dimensions[r].height = 21.0
    put(ws, f'B{r}', None, font(12, True), h='left', bd=row_bd)
    put(ws, f'C{r}', None, font(12), fmt=INT, h='center', bd=row_bd)
    put(ws, f'D{r}', F_SONDER, font(11), h='left', bd=row_bd)
    put(ws, f'E{r}', F_PARK, font(12), fmt=EURO, h='right', bd=row_bd)
    put(ws, f'F{r}', F_SALARY, font(12), fmt=EURO, h='right', bd=row_bd)
    put(ws, f'G{r}', F_TOTAL, font(12, True), fmt=EURO, h='right', bd=row_bd)
    put(ws, f'H{r}', F_COUNT, font(11, color=GREY), fmt=INT_DASH, h='center', bd=row_bd)
    put(ws, f'I{r}', None, font(10, color=GREY), h='left', bd=row_bd)
tot_bd = border(t=side(B_NAVY), b=side(B_NAVY, 'double'))
T = END_TOTAL
ws.row_dimensions[T].height = 26.0
put(ws, f'B{T}', 'Summe', font(12, True, NAVY), F_LIGHT, h='left', bd=tot_bd)
put(ws, f'C{T}', '=SUBTOTAL(109,tblEndliste[Arbeitstage])', font(12, True, NAVY), F_LIGHT, INT, h='center', bd=tot_bd)
put(ws, f'D{T}', '=IF(SUM(tblEndliste[davon Sondertage])=0,"",SUM(tblEndliste[davon Sondertage])&" Sondertage")', font(12, True, NAVY), F_LIGHT, h='left', bd=tot_bd)
put(ws, f'E{T}', '=SUBTOTAL(109,tblEndliste[Parkgebühr])', font(12, True, NAVY), F_LIGHT, EURO, h='right', bd=tot_bd)
put(ws, f'F{T}', '=SUBTOTAL(109,tblEndliste[Salary])', font(12, True, NAVY), F_LIGHT, EURO, h='right', bd=tot_bd)
put(ws, f'G{T}', '=SUBTOTAL(109,tblEndliste[Total Amount])', font(13, True, NAVY), F_LIGHT, EURO, h='right', bd=tot_bd)
put(ws, f'H{T}', '=SUBTOTAL(109,tblEndliste[davon Sondertage])', font(12, True, NAVY), F_LIGHT, INT_DASH, h='center', bd=tot_bd)
put(ws, f'I{T}', None, font(12, True, NAVY), F_LIGHT, h='left', bd=tot_bd)
heights(ws, {T + 1: 14.0, T + 2: 20.0, T + 3: 24.0, T + 4: 26.0, T + 5: 16.0})
put(ws, f'B{T + 2}', 'Sachlich und rechnerisch richtig.', font(12, True), v=None)
put(ws, f'B{T + 4}', '=IF(Pruefdatum="","",TEXT(DAY(Pruefdatum),"00")&"."&TEXT(MONTH(Pruefdatum),"00")&"."&YEAR(Pruefdatum))', font(12), h='left', v='bottom', bd=border(b=side(B_TEXT)))
put(ws, f'B{T + 5}', 'Datum', font(11), v='top')
put(ws, f'E{T + 5}', 'Unterschrift Prüfer/in', font(11), v='top')
add_table(ws, 'tblEndliste', f'B8:I{END_TOTAL}', [
    {'name': 'Name of Employee', 'totalLabel': 'Summe'},
    {'name': 'Arbeitstage', 'total': 'sum'},
    {'name': 'Sondertage', 'calc': F_SONDER[1:], 'total': 'custom', 'totalFormula': 'IF(SUM(tblEndliste[davon Sondertage])=0,"",SUM(tblEndliste[davon Sondertage])&" Sondertage")'},
    {'name': 'Parkgebühr', 'calc': F_PARK[1:], 'total': 'sum'},
    {'name': 'Salary', 'calc': F_SALARY[1:], 'total': 'sum'},
    {'name': 'Total Amount', 'calc': F_TOTAL[1:], 'total': 'sum'},
    {'name': 'davon Sondertage', 'calc': F_COUNT[1:], 'total': 'sum'},
    {'name': 'Bemerkung'}
], totals=True)
dv = DataValidation(type='decimal', operator='greaterThanOrEqual', formula1='0', allow_blank=True); dv.add('C5'); ws.add_data_validation(dv)
dv = DataValidation(type='list', formula1='Liste_Dolmetscher', allow_blank=True, showErrorMessage=False); dv.add(f'B{END_FIRST}:B{END_FIRST + 99}'); ws.add_data_validation(dv)
dv = DataValidation(type='whole', operator='greaterThanOrEqual', formula1='0', allow_blank=True); dv.add(f'C{END_FIRST}:C{END_FIRST + 99}'); ws.add_data_validation(dv)
ws.conditional_formatting.add('B1:I1', FormulaRule(formula=['E_Teile=""'], fill=fill('E3F4E8')))
ws.conditional_formatting.add('B1:I1', FormulaRule(formula=['E_Teile<>""'], fill=fill('FFF1D6')))
rng = lambda cols: f'{cols[0]}{END_FIRST}:{cols[-1]}{END_LAST}'
ws.conditional_formatting.add(rng('C'), FormulaRule(formula=[f'AND($B{END_FIRST}<>"",$C{END_FIRST}="")'], fill=fill('FFF1D6')))
ws.conditional_formatting.add(rng('D'), FormulaRule(formula=[f'ISNUMBER(SEARCH("prüfen",$D{END_FIRST}))'], fill=fill('FFF1D6')))
for cols in ('B', 'C', 'D', 'EI'):
    ws.conditional_formatting.add(rng(cols), FormulaRule(formula=[f'$H{END_FIRST}>0'], fill=fill('E6F4EA')))

# ======================================================================= Sondertage
ws = ws_son
SON_FIRST, SON_LAST = 7, 6 + N_SONDER
setup_sheet(ws, '2F7D32', 'landscape', 0, f"'Sondertage'!$B$2:$H${SON_LAST}", title_rows='6:6')
ws.freeze_panes = 'B7'
widths(ws, {'A': 2.0, 'B': 15.0, 'C': 18.0, 'D': 52.0, 'E': 16.0, 'F': 11.0, 'G': 42.0, 'H': 58.0, 'I': 18.0})
heights(ws, {1: 10.0, 2: 32.0, 5: 8.0, 6: 32.0})
put(ws, 'B2', 'Sondertage · besonders bezahlte Tage', font(18, True, NAVY))
link(ws, 'H2', '← zur Endliste', "'Endliste'!B9", h='right')
put(ws, 'B3', 'Jeder Tag, der nicht mit dem normalen Tagessatz bezahlt wird, bekommt hier eine Zeile – z. B. „Omar (100€)“ im Bemerkungsfeld oder „20.09.26 → 100€“ neben dem Namen auf dem Tagesblatt.', font(10, color=GREY), v=None)
put(ws, 'B4', 'Der Betrag ersetzt für diesen Tag den Tagessatz.   Zählt:  Ja = wird bezahlt  ·  Nein = wird nicht berücksichtigt  ·  prüfen = noch offen (wird noch nicht berechnet, steht in der Endliste in Orange).', font(10, color=GREY), v=None)
header_row(ws, 6, ['Name', 'Datum', 'Einsatz', 'Betrag für den Tag', 'Zählt', 'Vermerk auf dem Tagesblatt', 'Hinweis', 'Kurztext'], ['left', 'left', 'left', 'right', 'center', 'left', 'left', 'left'])
ws['E6'].alignment = Alignment(horizontal='right', vertical='center', wrap_text=True)
F_KURZ = '=IF(OR(tblSonder[[#This Row],[Zählt]]="Ja",tblSonder[[#This Row],[Zählt]]="prüfen"),TEXT(DAY(tblSonder[[#This Row],[Datum]]),"00")&"."&TEXT(MONTH(tblSonder[[#This Row],[Datum]]),"00")&".: "&tblSonder[[#This Row],[Betrag für den Tag]]&" €"&IF(tblSonder[[#This Row],[Zählt]]="prüfen"," (prüfen)",""),"")'
row_bd = border(b=side(B_ROW))
for r in range(SON_FIRST, SON_LAST + 1):
    ws.row_dimensions[r].height = 22.0
    put(ws, f'B{r}', None, font(11, True), h='left', bd=row_bd)
    put(ws, f'C{r}', None, font(11), fmt=DATE_DDD, h='left', bd=row_bd)
    put(ws, f'D{r}', None, font(11), h='left', bd=row_bd)
    put(ws, f'E{r}', None, font(11, True), fmt=EURO, h='right', bd=row_bd)
    put(ws, f'F{r}', None, font(11), h='center', bd=row_bd)
    put(ws, f'G{r}', None, font(11, color=GREY), h='left', bd=row_bd)
    put(ws, f'H{r}', None, font(11, color=GREY), h='left', bd=row_bd)
    put(ws, f'I{r}', F_KURZ, font(11, color=GREY), h='left', bd=row_bd)
add_table(ws, 'tblSonder', f'B6:I{SON_LAST}', [{'name': n} for n in ['Name', 'Datum', 'Einsatz', 'Betrag für den Tag', 'Zählt', 'Vermerk auf dem Tagesblatt', 'Hinweis']] + [{'name': 'Kurztext', 'calc': F_KURZ[1:]}])
dv = DataValidation(type='list', formula1='Liste_Dolmetscher', allow_blank=True, showErrorMessage=False); dv.add('B7:B500'); ws.add_data_validation(dv)
dv = DataValidation(type='list', formula1='Liste_Tage', allow_blank=True, showErrorMessage=False); dv.add('C7:C500'); ws.add_data_validation(dv)
dv = DataValidation(type='decimal', operator='greaterThanOrEqual', formula1='0', allow_blank=True); dv.add('E7:E500'); ws.add_data_validation(dv)
dv = DataValidation(type='list', formula1='"Ja,Nein,prüfen"', allow_blank=True); dv.add('F7:F500'); ws.add_data_validation(dv)
ws.conditional_formatting.add('F7:F500', CellIsRule(operator='equal', formula=['"Ja"'], fill=fill('DDF1E3')))
ws.conditional_formatting.add('F7:F500', CellIsRule(operator='equal', formula=['"prüfen"'], fill=fill('FFF1D6')))
ws.conditional_formatting.add('B7:H500', FormulaRule(formula=['$F7="prüfen"'], fill=fill('FFF8E8')))
ws.conditional_formatting.add('B7:H500', FormulaRule(formula=['$F7="Nein"'], font=Font(name='Arial', color='9CA3AF', strike=True)))

# ======================================================================= Übersicht
ws = ws_ueb
DOL_FIRST, DOL_LAST = 16, 15 + N_DOLM
setup_sheet(ws, '1F3A5F', 'portrait', 0, f"'Übersicht'!$B$2:$G${DOL_LAST}", title_rows='15:15')
widths(ws, {'A': 2.0, 'B': 24.0, 'C': 26.0, 'D': 11.0, 'E': 15.0, 'F': 16.0, 'G': 56.0, 'H': 2.0})
heights(ws, {1: 10.0, 2: 32.0, 3: 20.0, 4: 20.0, 5: 24.0, 6: 24.0, 7: 22.0, 8: 12.0, 9: 20.0, 10: 34.0, 11: 12.0, 12: 24.0, 13: 14.0, 14: 22.0, 15: 26.0})
put(ws, 'B2', 'Parkgebühren · Temporäre Dolmetscher/innen', font(18, True, NAVY))
put(ws, 'B3', '="Monatsabrechnung "&Abr_Text&"  ·  Zeitraum "&Abr_Zeitraum', font(11, color=MUTE), v=None)
L, R = side(B_ROW), side(B_ROW)
put(ws, 'F3', "So geht's", font(11, True, NAVY), F_LIGHT, bd=border(l=L, t=L))
put(ws, 'G3', None, font(10), F_LIGHT, v=None, bd=border(r=R, t=L))
put(ws, 'F4', '1   Monat, Jahr & Prüfdatum links wählen (gelbe Felder)', font(10), F_LIGHT, bd=border(l=L))
put(ws, 'G4', None, font(10), F_LIGHT, v=None, bd=border(r=R))
for coord, text, target in (('F5', '2   Belege eintragen  →', "'Belege'!B10"), ('F6', '3   Abrechnung pro Person drucken (ohne Unterschrift)  →', "'Abrechnung'!D5"), ('F7', '4   Übersicht für die Buchhaltung drucken (mit Datum + Unterschrift)  →', "'Übersicht Buchhaltung'!B2")):
    cell = link(ws, coord, text, target, h=None)
    cell.fill = fill(F_LIGHT)
    cell.border = border(l=L, b=L if coord == 'F7' else None)
    put(ws, f'G{coord[1]}', None, font(10), F_LIGHT, v=None, bd=border(r=R, b=L if coord == 'F7' else None))
put(ws, 'B5', 'Abrechnungsmonat', font(10, True))
inp = border(side(B_INPUT), side(B_INPUT), side(B_INPUT), side(B_INPUT))
put(ws, 'C5', 'Januar', font(11, True), F_YELLOW, h='center', bd=inp)
put(ws, 'D5', 2026, font(11, True), F_YELLOW, INT, h='center', bd=inp)
put(ws, 'B6', 'Prüfdatum', font(10, True))
put(ws, 'C6', None, font(11, True), F_YELLOW, DATE, h='center', bd=inp)
put(ws, 'D6', 'Datum für die Unterschrift', font(9, color=MUTE))
for coord, text in (('B9', 'GESAMTBETRAG'), ('D9', 'ANZAHL BELEGE'), ('F9', 'DOLMETSCHER/INNEN MIT BELEGEN')):
    put(ws, coord, text, font(8, True, MUTE), F_LIGHT, v='bottom', bd=border(l=L, t=L))
    nxt = get_column_letter(ws[coord].column + 1)
    put(ws, f'{nxt}9', None, font(10), F_LIGHT, v=None, bd=border(r=R, t=L))
    put(ws, f'{nxt}10', None, font(10), F_LIGHT, v=None, bd=border(r=R, b=L))
put(ws, 'B10', '=SUM(tblBelege[Betrag])', font(18, True, NAVY), F_LIGHT, EURO, h='left', bd=border(l=L, b=L))
put(ws, 'D10', '=COUNT(tblBelege[Betrag])', font(18, True, NAVY), F_LIGHT, INT, h='left', bd=border(l=L, b=L))
put(ws, 'F10', '=COUNTIF(tblDolmetscher[Belege],">0")&" von "&COUNTA(tblDolmetscher[Name])', font(18, True, NAVY), F_LIGHT, h='left', bd=border(l=L, b=L))
put(ws, 'B12', 'Prüfung', font(10, True))
put(ws, 'C12', '=Pruef_Meldung', font(10, True))
put(ws, 'B14', 'Dolmetscher/innen', font(12, True, NAVY), v=None)
put(ws, 'G14', 'Neue Person? Einfach in die nächste freie Zeile unter der Tabelle schreiben.', font(9, color=MUTE), h='right')
header_row(ws, 15, ['Name', 'Vollständiger Name', 'Belege', 'Summe', 'Status', 'Bemerkung'], ['left', 'left', 'center', 'right', 'center', 'left'])
F_DB = '=COUNTIFS(tblBelege[Name],tblDolmetscher[[#This Row],[Name]])'
F_DS = '=SUMIFS(tblBelege[Betrag],tblBelege[Name],tblDolmetscher[[#This Row],[Name]])'
row_bd = border(b=side(B_ROW))
for r in range(DOL_FIRST, DOL_LAST + 1):
    ws.row_dimensions[r].height = 22.0
    put(ws, f'B{r}', None, font(11, True), h='left', bd=row_bd)
    put(ws, f'C{r}', None, font(11), h='left', bd=row_bd)
    put(ws, f'D{r}', F_DB, font(11), fmt=INT_DASH, h='center', bd=row_bd)
    put(ws, f'E{r}', F_DS, font(11, True), fmt=EURO, h='right', bd=row_bd)
    put(ws, f'F{r}', None, font(11), h='center', bd=row_bd)
    put(ws, f'G{r}', None, font(11, color=GREY), h='left', bd=row_bd)
add_table(ws, 'tblDolmetscher', f'B15:G{DOL_LAST}', [{'name': 'Name'}, {'name': 'Vollständiger Name'}, {'name': 'Belege', 'calc': F_DB[1:]}, {'name': 'Summe', 'calc': F_DS[1:]}, {'name': 'Status'}, {'name': 'Bemerkung'}])
dv = DataValidation(type='date', operator='greaterThanOrEqual', formula1='DATE(2020,1,1)', allow_blank=True); dv.add('C6'); ws.add_data_validation(dv)
dv = DataValidation(type='list', formula1='Liste_Monate', allow_blank=False); dv.add('C5'); ws.add_data_validation(dv)
dv = DataValidation(type='list', formula1='Liste_Jahre', allow_blank=False); dv.add('D5'); ws.add_data_validation(dv)
dv = DataValidation(type='list', formula1='Liste_Status', allow_blank=True, showErrorMessage=False); dv.add('F16:F600'); ws.add_data_validation(dv)
ws.conditional_formatting.add('C12:G12', FormulaRule(formula=['Pruef_Teile=""'], fill=fill('E3F4E8')))
ws.conditional_formatting.add('C12:G12', FormulaRule(formula=['Pruef_Teile<>""'], fill=fill('FFF1D6')))
for value, color in (('erfasst', 'DCE8F7'), ('geprüft', 'FCEFD2'), ('ausgezahlt', 'DDF1E3'), ('Rückfrage', 'FBE0E0')):
    ws.conditional_formatting.add('F16:F600', CellIsRule(operator='equal', formula=[f'"{value}"'], fill=fill(color)))
ws.conditional_formatting.add('B16:G600', FormulaRule(formula=['$D16>0'], fill=fill('EAF1FB')))

# ======================================================================= Übersicht Buchhaltung
ws = ws_buch
BU_FIRST, BU_LAST = 10, 9 + N_BUCH
BU_SUM = BU_LAST + 1
setup_sheet(ws, 'B7791F', 'portrait', 1, f"'Übersicht Buchhaltung'!$B$2:$F${BU_SUM + 6}", left=0.45, top=0.5)
widths(ws, {'A': 2.0, 'B': 6.0, 'C': 17.5, 'D': 24.5, 'E': 20.5, 'F': 16.0, 'G': 3.0, 'H': 52.0, 'K': 13.0})
heights(ws, {1: 10.0, 2: 36.0, 3: 18.0, 4: 12.0, 5: 26.0, 6: 26.0, 7: 26.0, 8: 14.0, 9: 30.0})
put(ws, 'B2', 'Übersicht Parkgebühren', font(22, True, NAVY))
link(ws, 'H2', '← zur Übersicht', "'Übersicht'!C5")
put(ws, 'B3', 'Temporäre Dolmetscher/innen · Erstattung von Parkgebühren', font(11, color=GREY), v=None)
put(ws, 'H4', 'Diese Seite für die Buchhaltung drucken (Strg + P).', font(10, True, LINK), v=None)
L = side(B_ROW)
put(ws, 'B5', 'Abrechnungsmonat', font(11, True), F_LIGHT, bd=border(l=L, t=L))
put(ws, 'C5', None, font(10), F_LIGHT, v=None, bd=border(t=L))
put(ws, 'D5', '=Abr_Text', font(12, True), F_LIGHT, bd=border(t=L))
put(ws, 'E5', 'Dolmetscher/innen', font(11, True), F_LIGHT, h='right', bd=border(t=L))
put(ws, 'F5', '=COUNTIF(tblDolmetscher[Belege],">0")', font(12, True), F_LIGHT, INT, h='right', bd=border(r=L, t=L))
put(ws, 'H5', 'Die Liste füllt sich automatisch mit allen Dolmetscher/innen, die Belege haben.', font(9, color=MUTE), v=None)
put(ws, 'B6', 'Zeitraum', font(11, True), F_LIGHT, bd=border(l=L))
put(ws, 'C6', None, font(10), F_LIGHT, v=None)
put(ws, 'D6', '=Abr_Zeitraum', font(12), F_LIGHT)
put(ws, 'E6', 'Anzahl Belege', font(11, True), F_LIGHT, h='right')
put(ws, 'F6', '=COUNT(tblBelege[Betrag])', font(12, True), F_LIGHT, INT, h='right', bd=border(r=L))
put(ws, 'H6', 'Das Datum unten ist das Prüfdatum aus der Übersicht.', font(9, color=MUTE), v=None)
put(ws, 'B7', None, font(10), F_LIGHT, v=None, bd=border(l=L, b=L))
put(ws, 'C7', None, font(10), F_LIGHT, v=None, bd=border(b=L))
put(ws, 'D7', None, font(10), F_LIGHT, v=None, bd=border(b=L))
put(ws, 'E7', 'Gesamtbetrag', font(11, True), F_LIGHT, h='right', bd=border(b=L))
put(ws, 'F7', f'=F{BU_SUM}', font(14, True, NAVY), F_LIGHT, EURO, h='right', bd=border(r=L, b=L))
header_row(ws, 9, ['Nr.', 'Name', 'Vollständiger Name', 'Belege', 'Betrag'], ['center', 'left', 'left', 'center', 'right'], size=12)
put(ws, 'K9', 'Hilfsspalte (Zeile in tblDolmetscher)', font(10), v=None)
row_bd = border(b=side(B_ROW2))
for r in range(BU_FIRST, BU_LAST + 1):
    ws.row_dimensions[r].height = 20.0
    put(ws, f'B{r}', f'=IF($K{r}="","",ROWS($K${BU_FIRST}:K{r}))', font(12), fmt=INT, h='center', bd=row_bd)
    put(ws, f'C{r}', f'=IF($K{r}="","",INDEX(tblDolmetscher[Name],$K{r}))', font(12, True), h='left', bd=row_bd)
    put(ws, f'D{r}', f'=IF($K{r}="","",INDEX(tblDolmetscher[Vollständiger Name],$K{r})&"")', font(12), h='left', bd=row_bd)
    put(ws, f'E{r}', f'=IF($K{r}="","",INDEX(tblDolmetscher[Belege],$K{r}))', font(12), fmt=INT, h='center', bd=row_bd)
    put(ws, f'F{r}', f'=IF($K{r}="","",INDEX(tblDolmetscher[Summe],$K{r}))', font(12), fmt=EURO_BLANK, h='right', bd=row_bd)
    cell = put(ws, f'K{r}', None, font(10), v=None)
    cell.value = ArrayFormula(f'K{r}', f'=IFERROR(SMALL(IF(tblDolmetscher[Belege]>0,ROW(tblDolmetscher[Name])-ROW(tblDolmetscher[#Headers])),ROWS($K${BU_FIRST}:K{r})),"")')
put(ws, f'E{BU_SUM}', 'Gesamtsumme', font(13, True), h='right')
put(ws, f'F{BU_SUM}', f'=SUM(F{BU_FIRST}:F{BU_LAST})', font(14, True, NAVY), fmt=EURO, h='right', bd=border(t=side(B_NAVY), b=side(B_NAVY, 'double')))
put(ws, f'B{BU_SUM + 1}', f'=IF(COUNTIF(tblDolmetscher[Belege],">0")>{N_BUCH},"Achtung: mehr als {N_BUCH} Personen mit Belegen – nicht alle werden angezeigt.","")', font(10, True, AMBER), v=None)
put(ws, f'B{BU_SUM + 3}', 'Sachlich und rechnerisch richtig.', font(12, True), v=None)
put(ws, f'B{BU_SUM + 5}', '=IF(Pruefdatum="","",TEXT(DAY(Pruefdatum),"00")&"."&TEXT(MONTH(Pruefdatum),"00")&"."&YEAR(Pruefdatum))', font(12), h='left', v='bottom', bd=border(b=side(B_TEXT)))
put(ws, f'B{BU_SUM + 6}', 'Datum', font(11), v='top')
put(ws, f'E{BU_SUM + 6}', 'Unterschrift Prüfer/in', font(11), v='top')
heights(ws, {BU_SUM: 26.0, BU_SUM + 1: 16.0, BU_SUM + 3: 20.0, BU_SUM + 5: 26.0, BU_SUM + 6: 16.0})
ws.column_dimensions['K'].hidden = False

# ======================================================================= Belege
ws = ws_bel
BE_FIRST, BE_LAST = 10, 9 + N_BELEGE
setup_sheet(ws, '2E75B6', 'landscape', 0, None, title_rows='9:9')
ws.freeze_panes = 'B10'
ws.sheet_format.defaultRowHeight = 22.0
widths(ws, {'A': 2.0, 'B': 24.0, 'C': 18.0, 'D': 44.0, 'E': 12.0, 'F': 20.0, 'G': 40.0, 'H': 2.0})
heights(ws, {1: 10.0, 2: 32.0, 5: 8.0, 6: 22.0, 7: 22.0, 8: 8.0, 9: 26.0})
put(ws, 'B2', '="Belege · "&Abr_Text', font(18, True, NAVY))
link(ws, 'G2', '← zur Übersicht', "'Übersicht'!C5", h='right', size=9)
put(ws, 'B3', 'Jeder Parkbeleg = eine Zeile. Neue Belege einfach in die nächste freie Zeile direkt unter der Tabelle schreiben – die Tabelle wächst automatisch mit.', font(9, color=MUTE), v=None)
put(ws, 'B4', 'Per Klick (▼) auswählen: Name · Datum (alle Tage des Abrechnungsmonats) · Ort · Nachweis. Ort und Nachweis dürfen auch frei eingetippt werden.', font(9, color=MUTE), v=None)
put(ws, 'B6', 'Summe', font(10, True), v=None)
put(ws, 'C6', '=SUM(tblBelege[Betrag])', font(12, True, NAVY), fmt=EURO, h='left', v=None)
put(ws, 'D6', '="Anzahl Belege: "&COUNT(tblBelege[Betrag])', font(10, color=MUTE), v=None)
put(ws, 'B7', 'Prüfung', font(10, True))
put(ws, 'C7', '=Pruef_Meldung', font(10, True))
header_row(ws, 9, ['Name', 'Datum', 'Ort', 'Betrag', 'Nachweis', 'Bemerkung'], ['left', 'left', 'left', 'right', 'left', 'left'])
row_bd = border(b=side(B_ROW))
for r in range(BE_FIRST, BE_LAST + 1):
    ws.row_dimensions[r].height = 22.0
    put(ws, f'B{r}', None, font(11), h='left', bd=row_bd)
    put(ws, f'C{r}', None, font(11), fmt=DATE_DDD, h='left', bd=row_bd)
    put(ws, f'D{r}', None, font(11), h='left', bd=row_bd)
    put(ws, f'E{r}', None, font(11), fmt=EURO, h='right', bd=row_bd)
    put(ws, f'F{r}', None, font(11), h='left', bd=row_bd)
    put(ws, f'G{r}', None, font(11, color=GREY), h='left', bd=row_bd)
add_table(ws, 'tblBelege', f'B9:G{BE_LAST}', [{'name': n} for n in ['Name', 'Datum', 'Ort', 'Betrag', 'Nachweis', 'Bemerkung']])
dv = DataValidation(type='list', formula1='Liste_Dolmetscher', allow_blank=True, showErrorMessage=False); dv.add('B10:B2000'); ws.add_data_validation(dv)
dv = DataValidation(type='list', formula1='Liste_Tage', allow_blank=True, showErrorMessage=False); dv.add('C10:C2000'); ws.add_data_validation(dv)
dv = DataValidation(type='list', formula1='Liste_Orte', allow_blank=True, showErrorMessage=False); dv.add('D10:D2000'); ws.add_data_validation(dv)
dv = DataValidation(type='decimal', operator='greaterThanOrEqual', formula1='0', allow_blank=True); dv.add('E10:E2000'); ws.add_data_validation(dv)
dv = DataValidation(type='list', formula1='Liste_Nachweis', allow_blank=True, showErrorMessage=False); dv.add('F10:F2000'); ws.add_data_validation(dv)
ws.conditional_formatting.add('C7:G7', FormulaRule(formula=['Pruef_Teile=""'], fill=fill('E3F4E8')))
ws.conditional_formatting.add('C7:G7', FormulaRule(formula=['Pruef_Teile<>""'], fill=fill('FFF1D6')))
ws.conditional_formatting.add('C10:C2000', FormulaRule(formula=['AND($C10<>"",OR($C10<Abr_Start,$C10>Abr_Ende))'], fill=fill('FFF1D6')))
ws.conditional_formatting.add('C10:C2000', FormulaRule(formula=['AND($B10<>"",$C10="")'], fill=fill('FDE7E7')))
ws.conditional_formatting.add('B10:B2000', FormulaRule(formula=['AND($B10<>"",COUNTIF(Liste_Dolmetscher,$B10)=0)'], fill=fill('FDE7E7')))
ws.conditional_formatting.add('E10:E2000', FormulaRule(formula=['AND($B10<>"",$E10="")'], fill=fill('FDE7E7')))

# ======================================================================= Abrechnung (je Person)
ws = ws_abr
AB_FIRST, AB_LAST = 11, 10 + N_ABR
AB_SUM = AB_LAST + 1
setup_sheet(ws, '1E7B34', 'portrait', 1, f"'Abrechnung'!$B$2:$F${AB_SUM + 1}", left=0.3, top=0.5)
widths(ws, {'A': 2.0, 'B': 6.0, 'C': 12.0, 'D': 45.5, 'E': 21.5, 'F': 13.0, 'G': 3.0, 'H': 56.0, 'M': 13.0})
heights(ws, {1: 10.0, 2: 36.0, 3: 18.0, 4: 12.0, 5: 26.0, 6: 26.0, 7: 26.0, 8: 26.0, 9: 14.0, 10: 30.0})
put(ws, 'B2', 'Abrechnung Parkgebühren', font(22, True, NAVY))
link(ws, 'H2', '← zur Übersicht', "'Übersicht'!C5")
put(ws, 'B3', 'Temporäre Dolmetscher/innen · Erstattung von Parkgebühren', font(11, color=GREY), v=None)
L = side(B_ROW)
put(ws, 'B5', 'Dolmetscher/in', font(11, True), F_LIGHT, bd=border(l=L, t=L))
put(ws, 'C5', None, font(10), F_LIGHT, v=None, bd=border(t=L))
put(ws, 'D5', None, font(13, True), F_YELLOW, h='left', bd=border(side(B_INPUT), side(B_INPUT), side(B_INPUT), side(B_INPUT)))
put(ws, 'E5', 'Anzahl Belege', font(11, True), F_LIGHT, h='right', bd=border(t=L))
put(ws, 'F5', '=COUNTIFS(tblBelege[Name],$D$5)', font(12, True), F_LIGHT, INT, h='right', bd=border(r=L, t=L))
put(ws, 'H5', '◄ Name per Klick (▼) auswählen – danach drucken (Strg + P)', font(10, True, LINK))
put(ws, 'B6', 'Name', font(11, True), F_LIGHT, bd=border(l=L))
put(ws, 'C6', None, font(10), F_LIGHT, v=None)
put(ws, 'D6', '=IFERROR(IF(INDEX(tblDolmetscher[Vollständiger Name],MATCH($D$5,tblDolmetscher[Name],0))="",$D$5,INDEX(tblDolmetscher[Vollständiger Name],MATCH($D$5,tblDolmetscher[Name],0))),$D$5)', font(12, True), F_LIGHT)
put(ws, 'E6', 'Gesamtbetrag', font(11, True), F_LIGHT, h='right')
put(ws, 'F6', f'=F{AB_SUM}', font(14, True, NAVY), F_LIGHT, EURO, h='right', bd=border(r=L))
put(ws, 'H6', 'Die Liste füllt sich automatisch aus dem Blatt „Belege“ (nach Datum sortiert).', font(9, color=MUTE))
put(ws, 'B7', 'Monat', font(11, True), F_LIGHT, bd=border(l=L))
put(ws, 'C7', None, font(10), F_LIGHT, v=None)
put(ws, 'D7', '=Abr_Text', font(12), F_LIGHT)
put(ws, 'E7', None, font(10), F_LIGHT, v=None)
put(ws, 'F7', None, font(10), F_LIGHT, v=None, bd=border(r=L))
put(ws, 'H7', 'Datum und Unterschrift stehen nur auf der „Übersicht Buchhaltung“.', font(9, color=MUTE))
put(ws, 'B8', 'Zeitraum', font(11, True), F_LIGHT, bd=border(l=L, b=L))
put(ws, 'C8', None, font(10), F_LIGHT, v=None, bd=border(b=L))
put(ws, 'D8', '=Abr_Zeitraum', font(12), F_LIGHT, bd=border(b=L))
put(ws, 'E8', None, font(10), F_LIGHT, v=None, bd=border(b=L))
put(ws, 'F8', None, font(10), F_LIGHT, v=None, bd=border(r=L, b=L))
header_row(ws, 10, ['Nr.', 'Datum', 'Ort / Parkplatz', 'Nachweis', 'Betrag'], ['center', 'center', 'left', 'left', 'right'], size=12)
put(ws, 'M10', 'Hilfsspalte (Sortierschlüssel)', font(10), v=None)
row_bd = border(b=side(B_ROW2))
for r in range(AB_FIRST, AB_LAST + 1):
    ws.row_dimensions[r].height = 20.0
    put(ws, f'B{r}', f'=IF($M{r}="","",ROWS($M${AB_FIRST}:M{r}))', font(12), fmt=INT, h='center', bd=row_bd)
    put(ws, f'C{r}', f'=IF($M{r}="","",INDEX(tblBelege[Datum],MOD($M{r},10000)))', font(12), fmt=DATE_BLANK, h='center', bd=row_bd)
    put(ws, f'D{r}', f'=IF($M{r}="","",INDEX(tblBelege[Ort],MOD($M{r},10000))&"")', font(12), h='left', bd=row_bd)
    put(ws, f'E{r}', f'=IF($M{r}="","",INDEX(tblBelege[Nachweis],MOD($M{r},10000))&"")', font(12), h='left', bd=row_bd)
    put(ws, f'F{r}', f'=IF($M{r}="","",INDEX(tblBelege[Betrag],MOD($M{r},10000)))', font(12), fmt=EURO_BLANK, h='right', bd=row_bd)
    cell = put(ws, f'M{r}', None, font(10), v=None)
    cell.value = ArrayFormula(f'M{r}', f'=IFERROR(SMALL(IF((tblBelege[Name]=$D$5)*(tblBelege[Name]<>""),tblBelege[Datum]*10000+ROW(tblBelege[Name])-ROW(tblBelege[#Headers])),ROWS($M${AB_FIRST}:M{r})),"")')
put(ws, f'E{AB_SUM}', 'Summe', font(13, True), h='right')
put(ws, f'F{AB_SUM}', f'=SUM(F{AB_FIRST}:F{AB_LAST})', font(14, True, NAVY), fmt=EURO, h='right', bd=border(t=side(B_NAVY), b=side(B_NAVY, 'double')))
put(ws, f'B{AB_SUM + 1}', f'=IF(F5=0,"Für "&$D$5&" sind im Abrechnungsmonat keine Belege erfasst.",IF(F5>{N_ABR},"Achtung: mehr als {N_ABR} Belege – nicht alle werden angezeigt.",""))', font(10, True, AMBER), v=None)
heights(ws, {AB_SUM: 26.0, AB_SUM + 1: 16.0})
dv = DataValidation(type='list', formula1='Liste_Dolmetscher', allow_blank=True, showErrorMessage=False); dv.add('D5'); ws.add_data_validation(dv)

# ======================================================================= Listen
ws = ws_lst
setup_sheet(ws, '9CA3AF', 'landscape', 0, "'Listen'!$B$2:$O$37")
widths(ws, {'A': 2.0, 'B': 14.0, 'C': 2.0, 'D': 9.0, 'E': 2.0, 'F': 40.0, 'G': 2.0, 'H': 22.0, 'I': 2.0, 'J': 14.0, 'K': 2.0, 'L': 22.0, 'M': 2.0, 'N': 30.0, 'O': 60.0})
heights(ws, {1: 10.0, 2: 26.0, 6: 22.0})
put(ws, 'B2', 'Listen & Einstellungen', font(16, True, NAVY), v=None)
put(ws, 'B3', 'Auswahllisten erweitern: einfach in die nächste freie Zeile unter der jeweiligen Liste schreiben – die Dropdowns übernehmen neue Einträge automatisch.', font(9, color=MUTE), v=None)
put(ws, 'B4', 'Grau hinterlegte Bereiche werden automatisch berechnet – bitte nicht ändern.', font(9, color=MUTE), v=None)
for coord, text in (('B6', 'Monate'), ('D6', 'Jahre'), ('F6', 'Orte / Parkplätze'), ('H6', 'Nachweis'), ('J6', 'Status')):
    put(ws, coord, text, font(10, True, WHITE), NAVY, h='left')
put(ws, 'L6', 'Tage im Monat (auto)', font(10, True, WHITE), F_MUTE, h='left')
put(ws, 'N6', 'Berechnete Werte (auto)', font(10, True, WHITE), F_MUTE, h='left')
MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember']
ORTE = ['Alte Bahnhofgarage, Bonn', 'Aral, Bonn (Diesel)', 'ATOS Orthoparc Klinik Köln', 'Flughafen Düsseldorf', 'Flughafen Frankfurt', 'Helios Klinikum Krefeld',
        'Johanniter-Krankenhaus Bonn', 'Parkgarage Bad Homburg', 'Parkgarage Bonner Bogen, Bonn', 'Parkhaus City Terrassen, Bonn', 'Parkhaus Friedensplatz, Bonn',
        'Parkhaus Grupellostraße, Düsseldorf', 'Parkhaus Insel Hotel, Bonn-Bad Godesberg', 'Parkhaus Kö-Bogen, Düsseldorf', 'Parkhaus LANXESS arena, Köln',
        'Parkhaus Schadow Arkaden, Düsseldorf', 'Parkscheinautomat Ännchenplatz, Bonn', 'Parkscheinautomat Beethovenstr. 8', 'Parkscheinautomat Bonner Talweg, Bonn',
        'Parkscheinautomat Boxgraben 68', 'Parkscheinautomat Friedrichstraße 14', 'Parkscheinautomat Hansaring 100', 'Parkscheinautomat Im Wieschen 3',
        'Parkscheinautomat Leichtensternstr. 6a', 'Parkscheinautomat Schleidener Str. 3', 'Parkscheinautomat Villichgasse, Bonn', 'Parkscheinautomat Weyertal (KH-Eingang)',
        'Petruskrankenhaus Bonn', 'Stiftsgarage Bonn', 'Tiefgarage Fronhofer, Bonn-Bad Godesberg', 'Uniklinik Köln', 'Uniklinik RWTH Aachen', 'Universitätsklinikum Bonn', 'Universitätsklinikum Düsseldorf']
NACHWEIS = ['Parkbeleg', 'Parkschein', 'Kartenbeleg', 'Digitaler Beleg', 'Kontoumsatz (App)', 'Quittung', 'Sonstiges']
STATUS = ['erfasst', 'geprüft', 'ausgezahlt', 'Rückfrage']
lb = border(b=side(B_ROW))
for i, m in enumerate(MONTHS):
    put(ws, f'B{7 + i}', m, font(10), h='left', bd=lb)
for i, y in enumerate(range(2024, 2036)):
    put(ws, f'D{7 + i}', y, font(10), fmt=INT, h='left', bd=lb)
for i, o in enumerate(ORTE):
    put(ws, f'F{7 + i}', o, font(10), h='left', bd=lb)
for i, n in enumerate(NACHWEIS):
    put(ws, f'H{7 + i}', n, font(10), h='left', bd=lb)
for i, s in enumerate(STATUS):
    put(ws, f'J{7 + i}', s, font(10), h='left', bd=lb)
for d in range(1, 32):
    put(ws, f'L{6 + d}', f'=IF({d}<=DAY(Abr_Ende),Abr_Start+{d - 1},"")', font(10, color=MUTE), F_LIGHT, DATE_DDD, h='left', v=None)
CALC = [
    ('Monat (Nr.)', '=MATCH(Abr_Monat,Liste_Monate,0)', INT),
    ('Monatsbeginn', '=DATE(Abr_Jahr,Abr_MonatNr,1)', DATE),
    ('Monatsende', '=EOMONTH(Abr_Start,0)', DATE),
    ('Abrechnungsmonat (Text)', '=Abr_Monat&" "&Abr_Jahr', None),
    ('Zeitraum (Text)', '=TEXT(DAY(Abr_Start),"00")&"."&TEXT(Abr_MonatNr,"00")&"."&Abr_Jahr&" – "&TEXT(DAY(Abr_Ende),"00")&"."&TEXT(Abr_MonatNr,"00")&"."&Abr_Jahr', None),
    ('Belege ohne gültigen Namen', '=SUMPRODUCT((((tblBelege[Betrag]<>"")+(tblBelege[Datum]<>""))>0)*(COUNTIF(Liste_Dolmetscher,tblBelege[Name]&"")=0))', INT),
    ('Belege außerhalb des Monats', '=SUMPRODUCT((tblBelege[Datum]<>"")*(((tblBelege[Datum]<Abr_Start)+(tblBelege[Datum]>Abr_Ende))>0))', INT),
    ('Unvollständige Belege', '=SUMPRODUCT((tblBelege[Name]<>"")*(((tblBelege[Datum]="")+(tblBelege[Betrag]=""))>0))', INT),
    ('Prüfhinweise (Teiltexte)', '=IF(Pruef_OhneName>0,Pruef_OhneName&" ohne gültigen Namen · ","")&IF(Pruef_Ausserhalb>0,Pruef_Ausserhalb&" außerhalb des Abrechnungsmonats · ","")&IF(Pruef_Unvollst>0,Pruef_Unvollst&" unvollständig (Datum/Betrag fehlt) · ","")', None),
    ('Prüfmeldung', '=IF(Pruef_Teile="","Alles in Ordnung – alle Belege sind vollständig, einer Person zugeordnet und im Abrechnungsmonat.","Bitte prüfen – Belege: "&LEFT(Pruef_Teile,LEN(Pruef_Teile)-3))', None),
    ('Endliste: Personen mit Parkbelegen fehlen', '=SUMPRODUCT((tblDolmetscher[Summe]>0)*(COUNTIF(tblEndliste[Name of Employee],tblDolmetscher[Name])=0))', INT),
    ('Endliste: Sondertage ohne Person', '=SUMPRODUCT((tblSonder[Name]<>"")*(COUNTIF(tblEndliste[Name of Employee],tblSonder[Name])=0))', INT),
    ('Endliste: Personen ohne Arbeitstage', '=SUMPRODUCT((tblEndliste[Name of Employee]<>"")*(tblEndliste[Arbeitstage]=""))', INT),
    ('Endliste: mehr Sondertage als Arbeitstage', '=SUMPRODUCT((tblEndliste[Name of Employee]<>"")*(tblEndliste[davon Sondertage]>tblEndliste[Arbeitstage]))', INT),
    ('Endliste: Sondertage „prüfen“', '=COUNTIF(tblSonder[Zählt],"prüfen")', INT),
    ('Endliste: Prüfhinweise (Teiltexte)', '=IF(E_Pruefen>0,E_Pruefen&" Sondertag(e) noch „prüfen“ · ","")&IF(E_OhneTage>0,E_OhneTage&" Person(en) ohne Arbeitstage · ","")&IF(E_FehltParker>0,E_FehltParker&" Person(en) mit Parkbelegen fehlen in der Liste · ","")&IF(E_SonderOhne>0,E_SonderOhne&" Sondertag(e) ohne Person in der Liste · ","")&IF(E_Zuviel>0,E_Zuviel&" Person(en) mit mehr Sondertagen als Arbeitstagen · ","")', None),
    ('Endliste: Prüfmeldung', '=IF(E_Teile="","Endliste vollständig – alle Personen haben Arbeitstage, alle Sondertage sind geklärt.","Bitte prüfen: "&LEFT(E_Teile,LEN(E_Teile)-3))', None),
]
for i, (label, formula, fmt) in enumerate(CALC):
    put(ws, f'N{7 + i}', label, font(10, color=MUTE), F_LIGHT, h='left', v=None)
    put(ws, f'O{7 + i}', formula, font(10, color=MUTE), F_LIGHT, fmt, h='left', v=None)

# ======================================================================= Namen
NAMES = {
    'Abr_MonatNr': 'Listen!$O$7', 'Abr_Start': 'Listen!$O$8', 'Abr_Ende': 'Listen!$O$9', 'Abr_Text': 'Listen!$O$10', 'Abr_Zeitraum': 'Listen!$O$11',
    'Pruef_OhneName': 'Listen!$O$12', 'Pruef_Ausserhalb': 'Listen!$O$13', 'Pruef_Unvollst': 'Listen!$O$14', 'Pruef_Teile': 'Listen!$O$15', 'Pruef_Meldung': 'Listen!$O$16',
    'E_FehltParker': 'Listen!$O$17', 'E_SonderOhne': 'Listen!$O$18', 'E_OhneTage': 'Listen!$O$19', 'E_Zuviel': 'Listen!$O$20', 'E_Pruefen': 'Listen!$O$21', 'E_Teile': 'Listen!$O$22', 'E_Meldung': 'Listen!$O$23',
    'Liste_Dolmetscher': "'Übersicht'!$B$16:INDEX('Übersicht'!$B$16:$B$600,MAX(1,COUNTA('Übersicht'!$B$16:$B$600)))",
    'Abr_Monat': "'Übersicht'!$C$5", 'Abr_Jahr': "'Übersicht'!$D$5", 'Pruefdatum': "'Übersicht'!$C$6", 'Tagessatz': "'Endliste'!$C$5",
    'Liste_Monate': 'Listen!$B$7:$B$18',
    'Liste_Jahre': 'Listen!$D$7:INDEX(Listen!$D$7:$D$200,MAX(1,COUNTA(Listen!$D$7:$D$200)))',
    'Liste_Orte': 'Listen!$F$7:INDEX(Listen!$F$7:$F$500,MAX(1,COUNTA(Listen!$F$7:$F$500)))',
    'Liste_Nachweis': 'Listen!$H$7:INDEX(Listen!$H$7:$H$200,MAX(1,COUNTA(Listen!$H$7:$H$200)))',
    'Liste_Status': 'Listen!$J$7:INDEX(Listen!$J$7:$J$200,MAX(1,COUNTA(Listen!$J$7:$J$200)))',
    'Liste_Tage': 'Listen!$L$7:INDEX(Listen!$L$7:$L$37,DAY(Abr_Ende))',
}
for name, ref in NAMES.items():
    wb.defined_names[name] = DefinedName(name, attr_text=ref)

wb.calculation.fullCalcOnLoad = True
wb.active = 0
wb.save(OUT)
print('geschrieben:', OUT)
