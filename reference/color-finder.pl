use strict;
use warnings;
use utf8;
binmode(STDOUT, ":encoding(UTF-8)");

use Math::Trig qw(pi deg2rad);
use Text::CSV;


# Open output file with UTF-8 encoding
open my $out, ">:encoding(UTF-8)", "results.txt" or die $!;
open my $conflicts, ">:encoding(UTF-8)", "conflicts.txt" or die $!;


open STDERR, ">:encoding(UTF-8)", "warnings.log" or die $!;
warn "This goes into warnings.log\n";

open my $log, ">:encoding(UTF-8)", "log.txt" or die $!;

my $firstfile = 1;

# --- Load multiple CSVs into lookup ---
sub load_colors {
    my (@filenames) = @_;
    my $csv = Text::CSV->new({ binary => 1 });
    my @colors;
    my %seen_name;
    my %seen_hex;

    for my $filename (@filenames) {
        open my $fh, "<:encoding(utf8)", $filename or die $!;
        $csv->getline($fh); # skip header

        while (my $row = $csv->getline($fh)) {
            my ($name, $hex, $good) = @$row;
            next unless $name && $hex;

            my $lname = lc $name;
            my $uhex  = uc $hex;

            # skip if already seen from earlier file
            warn "Skipping duplicate $name ($hex) from $filename\n"
                if $seen_name{lc $name} || $seen_hex{uc $hex};
            next if $seen_name{$lname} || $seen_hex{$uhex};

            print $log "Added $name ($hex) from $filename\n";

            push @colors, { name => $name, hex => $uhex };
            $seen_name{$lname} = 1;
            $seen_hex{$uhex}   = 1;
        }
        close $fh;
    }

    $firstfile = 0;
    return @colors;
}

use Text::CSV;

# Compare two color lists and report conflicts
sub find_conflicts {
    my ($list1, $list2) = @_;  # each is arrayref of { name, hex }

    my %name_to_hex1;
    my %hex_to_name1;

    # normalize helper
    sub norm_name { lc shift }
    sub norm_hex  { uc shift }

    # index first list
    for my $c (@$list1) {
        $name_to_hex1{ norm_name($c->{name}) } = norm_hex($c->{hex});
        $hex_to_name1{ norm_hex($c->{hex}) }   = $c->{name};
    }

    my @conflicts;

    # check second list against first
    for my $c (@$list2) {
        my $n = norm_name($c->{name});
        my $h = norm_hex($c->{hex});

        if (exists $name_to_hex1{$n} && $name_to_hex1{$n} ne $h) {
            push @conflicts, {
                type => "name_conflict",
                name => $c->{name},
                hex1 => $name_to_hex1{$n},
                hex2 => $h,
            };
        }
        elsif (exists $hex_to_name1{$h} && lc($hex_to_name1{$h}) ne $n) {
            push @conflicts, {
                type => "hex_conflict",
                hex  => $h,
                name1 => $hex_to_name1{$h},
                name2 => $c->{name},
            };
        }
    }

    return @conflicts;
}


# Convert color name → hex
sub name_to_hex {
    my ($name, $lookup) = @_;
    return $lookup->{lc $name};
}

# Convert hex → color name
sub hex_to_name {
    my ($hex, $lookup) = @_;
    return $lookup->{lc $hex};
}

sub color_similarity {
    my ($hex1, $hex2) = @_;

    # --- helper conversions ---
    my $hex_to_rgb = sub {
        my ($hex) = @_;
        $hex =~ s/^#//;
        my ($r,$g,$b) = map { hex($_) } ($hex =~ /(..)(..)(..)/);
        return ($r/255, $g/255, $b/255);
    };

    my $srgb_to_linear = sub {
        my ($c) = @_;
        return ($c <= 0.04045) ? $c/12.92 : ((($c+0.055)/1.055)**2.4);
    };

    my $rgb_to_xyz = sub {
        my ($r,$g,$b) = @_;
        $r = $srgb_to_linear->($r);
        $g = $srgb_to_linear->($g);
        $b = $srgb_to_linear->($b);
        my $x = $r*0.4124564 + $g*0.3575761 + $b*0.1804375;
        my $y = $r*0.2126729 + $g*0.7151522 + $b*0.0721750;
        my $z = $r*0.0193339 + $g*0.1191920 + $b*0.9503041;
        return ($x,$y,$z);
    };

    my $xyz_to_lab = sub {
        my ($x,$y,$z) = @_;
        my ($xn,$yn,$zn) = (0.95047,1.00000,1.08883); # D65 reference
        $x /= $xn; $y /= $yn; $z /= $zn;
        my $f = sub {
            my ($t) = @_;
            return ($t > (6/29)**3) ? $t**(1/3) : (1/3)*(29/6)**2*$t + 4/29;
        };
        my $fx = $f->($x);
        my $fy = $f->($y);
        my $fz = $f->($z);
        my $L = 116*$fy - 16;
        my $a = 500*($fx - $fy);
        my $b = 200*($fy - $fz);
        return ($L,$a,$b);
    };

    # --- ΔE00 calculation ---
    my $ciede2000 = sub {
        my ($L1,$a1,$b1,$L2,$a2,$b2) = @_;
        my $C1 = sqrt($a1**2 + $b1**2);
        my $C2 = sqrt($a2**2 + $b2**2);
        my $Cbar = ($C1+$C2)/2;
        my $G = 0.5*(1 - sqrt($Cbar**7/($Cbar**7+25**7)));
        my $a1p = (1+$G)*$a1;
        my $a2p = (1+$G)*$a2;
        my $C1p = sqrt($a1p**2 + $b1**2);
        my $C2p = sqrt($a2p**2 + $b2**2);
        my $h1p = atan2($b1,$a1p); $h1p += 2*pi if $h1p < 0;
        my $h2p = atan2($b2,$a2p); $h2p += 2*pi if $h2p < 0;

        my $dLp = $L2 - $L1;
        my $dCp = $C2p - $C1p;
        my $dhp = $h2p - $h1p;
        if (abs($dhp) > pi) {
            $dhp += 2*pi if $h2p <= $h1p;
            $dhp -= 2*pi if $h2p > $h1p;
        }
        my $dHp = 2*sqrt($C1p*$C2p)*sin($dhp/2);

        my $Lbarp = ($L1+$L2)/2;
        my $Cbarp = ($C1p+$C2p)/2;
        my $hbarp = ($h1p+$h2p)/2;
        if (abs($h1p-$h2p) > pi) {
            $hbarp += pi if ($h1p+$h2p) < 2*pi;
            $hbarp -= pi if ($h1p+$h2p) >= 2*pi;
        }

        my $T = 1 - 0.17*cos($hbarp - deg2rad(30))
                  + 0.24*cos(2*$hbarp)
                  + 0.32*cos(3*$hbarp + deg2rad(6))
                  - 0.20*cos(4*$hbarp - deg2rad(63));
        my $Sl = 1 + (0.015*($Lbarp-50)**2)/sqrt(20+($Lbarp-50)**2);
        my $Sc = 1 + 0.045*$Cbarp;
        my $Sh = 1 + 0.015*$Cbarp*$T;
        my $dtheta = deg2rad(30)*exp(-(($hbarp - deg2rad(275))/deg2rad(25))**2);
        my $Rc = 2*sqrt($Cbarp**7/($Cbarp**7+25**7));
        my $Rt = -$Rc*sin(2*$dtheta);

        return sqrt(
            ($dLp/$Sl)**2 +
            ($dCp/$Sc)**2 +
            ($dHp/$Sh)**2 +
            $Rt*($dCp/$Sc)*($dHp/$Sh)
        );
    };

    # --- pipeline ---
    my ($r1,$g1,$b1) = $hex_to_rgb->($hex1);
    my ($x1,$y1,$z1) = $rgb_to_xyz->($r1,$g1,$b1);
    my ($L1,$a1,$b1_) = $xyz_to_lab->($x1,$y1,$z1);

    my ($r2,$g2,$b2) = $hex_to_rgb->($hex2);
    my ($x2,$y2,$z2) = $rgb_to_xyz->($r2,$g2,$b2);
    my ($L2,$a2,$b2_) = $xyz_to_lab->($x2,$y2,$z2);

    my $dE00 = $ciede2000->($L1,$a1,$b1_,$L2,$a2,$b2_);

    # similarity mapping: 100% at ΔE00=0, 0% at ΔE00=100+
    my $similarity = 100*(1 - $dE00/100);
    $similarity = 0 if $similarity < 0;
    $similarity = 100 if $similarity > 100;

    return $similarity;
}




# --- Find matches within similarity band ---
sub find_similar_colors {
    my ($target_name, $target_sim, $tolerance, $colors, $name_to_hex) = @_;

    my $target_hex = $name_to_hex->{lc $target_name};
    die "Unknown color name: $target_name\n" unless $target_hex;

    my @matches;
    for my $c (@$colors) {
        my $sim = color_similarity($target_hex, $c->{hex});
        if (abs($sim - $target_sim) <= $tolerance) {
            push @matches, { %$c, similarity => $sim };
        }
    }
    return @matches;
}

# guesses is a hashref: { "Red" => 86.04, "Poppy Red" => 87.45 }
# tolerance is a numeric percentage band (e.g. 2 means ±2%)
sub find_consistent_colors {
    my ($guesses, $tolerance, $colors, $name_to_hex) = @_;

    my @matches;
    COLOR: for my $c (@$colors) {
        my %deviations;
        my $total_dev = 0;
        for my $guess_name (keys %$guesses) {
            my $target_hex = $name_to_hex->{lc $guess_name};
            next COLOR unless $target_hex;  # skip if guess not found

            my $target_sim = $guesses->{$guess_name};
            my $sim = color_similarity($target_hex, $c->{hex});
            my $dev = abs($sim - $target_sim);
            $deviations{$guess_name} = $dev;
            $total_dev += $dev;

            # reject if outside tolerance
            if ($dev > $tolerance) {
                next COLOR;
            }
        }
        # survived all guesses
        push @matches, { %$c, deviations => \%deviations, total_dev => $total_dev };
    }
    return @matches;
}

my @all_colors = load_colors("colornames.csv", "css-x11.csv", "extras.csv");

my %name_to_hex = map { lc($_->{name}) => $_->{hex} } @all_colors;

# Hash of guesses and similarity values
my %guesses = (
    "White Blue"       => 90,
    "Bubblegum" => 90,
);

# Find colors within ±2% of all guesses
# After calling find_consistent_colors
# After filtering and sorting


my @consistent = find_consistent_colors(\%guesses, 8, \@all_colors, \%name_to_hex);

# Exclude already guessed names
@consistent = grep { !exists $guesses{ $_->{name} } } @consistent;

# Sort by total deviation (lowest first)
@consistent = sort { $a->{total_dev} <=> $b->{total_dev} } @consistent;




my $limit = @consistent < 10 ? @consistent : 10;

for my $i (0 .. $limit-1) {
    my $c = $consistent[$i];
    print $out "$c->{name} ($c->{hex})\n";

    for my $g (sort keys %{$c->{deviations}}) {
        my $hex = $name_to_hex{lc $g} // "[no hex]";
        printf $out "  deviation vs %-15s (%s) => %.2f%%\n",
            $g, $hex, $c->{deviations}{$g};
    }

    printf $out "  total deviation => %.2f%%\n\n", $c->{total_dev};
}

close $out;
close $log;


my @repo_colors = load_colors("colornames.csv");
my @x11_colors  = load_colors("css-x11.csv");

my @conflicts = find_conflicts(\@x11_colors, \@repo_colors);

sub print_conflicts_grouped {
    my (@conflicts) = @_;

    # Build groups keyed by either name or hex
    my %groups;
    for my $c (@conflicts) {
        my $key;
        if ($c->{type} eq "name_conflict") {
            $key = lc($c->{name});
        } elsif ($c->{type} eq "hex_conflict") {
            $key = lc($c->{name1});
        }
        push @{ $groups{$key} }, $c;
    }

    # Print groups sorted by key
    for my $key (sort keys %groups) {
        for my $c (@{ $groups{$key} }) {
            if ($c->{type} eq "name_conflict") {
                print $conflicts "$c->{name}\t$c->{hex1}\t\t[ $c->{hex2} ]\n";
            } elsif ($c->{type} eq "hex_conflict") {
                print $conflicts "$c->{name1}\t$c->{hex}\t\t[ $c->{name2} ]\n";
            }
        }
        print $conflicts "\n"; # blank line between groups
    }
}
print_conflicts_grouped(@conflicts);