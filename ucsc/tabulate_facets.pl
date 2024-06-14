#!/usr/bin/env perl
#
# File: tablulate_facets.pl by Marc Perry
# 
# 
# 
#
# Last Updated: 2024-06-13, Status: working as advertised

use strict;
use warnings;
use JSON;

=head1 NAME

tabulate_facets.pl


INPUT: dataset.json, a file required to run the UCSC Cell Browser, it contains an aggregate
       of all kinds of information from each dataset that has been built
       on the alpha, or test (or dev) server for the data wranglers this file lives here:
       /usr/local/apache/htdocs-cells/dataset.json

OUTPUT: 8 TSV tables (one for each of the searchable facets currently on the Cell Browser landing page):
        assays_table.tsv
        body_parts_table.tsv
        diseases_table.tsv
        domains_table.tsv
        life_stages_table.tsv
        organisms_table.tsv
        projects_table.tsv
        sources_table.tsv

        Each table is named after the 'key' or facet name, in the dataset.json file
        And has a header.
        There are three columns:
        column 1 = a list of the 'term', for that particular facet which are the 'values' that the 
                   script extracts when parsing the JSON file
        column 2 = the count of the number of datasets that use this term
        column 3 = the names of all the datasets that use this term (listed as a CSV field inside the TSV table)

NOTES:  The code could have been constructed with a set of 8 sequential if (  ) conditional test blocks
        (not all datasets use all 8 of the facet keys), and then repetitive code to parse the data
        structure.  But to make the script "cleaner" the repetitive code was extracted into a single 
        subroutine that contains the function, and gets called 8 times in a row.


        Since we know in advance the names of the facet keys that we want to tabulate, the script 
        uses an array (list) of the facet names and checks for each one sequentially.  It made sense
        (to me) to accumulate the related data for each facet in 8 different hashes (dictionaries)
        that are named after their respective facet.


        To allow us to use the facet name to select the correctly named data structure, the code
        uses a special hash inside the subroutine, which links the name of the facet to the correctly
        named %hash, sort of like a "dispatch table."  The code that accomplishes this is a little
        more complicated then you might encounter in a basic Perl script--and is not explained in
        detail.


        After parsing the input the script uses a second subroutine to print out each
        Global %hash as its own TSV table (and since the  output tables are named after their facet,
        (basically on-the-fly) it also uses a dispatch table hash).

=cut

my $USAGE = "USAGE:\n $0 /path/to/dataset.json\n";

die $USAGE unless $ARGV[0];
my $json_file = shift;

unless ( -e -f -r $json_file ) {
    die "JSON document specified on the command line either does not exist, is not a file, or is not readable\n";
}

open my ($FH), '<', $json_file or die "Could not open $json_file";

# A Global variable to hold input data
my $json = q{};

# Iterates over the rows of a pretty-printed JSON document
# and aggregates them into the $json variable
while ( <$FH> ) {
    $json .= $_;
}

# A method from the JSON.pm Perl module that converts the input JSON
# into a Perl data structure, and produces a reference to a Perl hash
my $data = decode_json( $json );

# These Global data structures get populated with data
# while parsing the incoming JSON file
my %body_parts = ();
my %diseases = ();
my %organisms = ();
my %projects = ();
my %life_stages = ();
my %domains = ();
my %sources = ();
my %assays = ();


# From previous characterization of this aggregated dataset.json file I know that
# everything I want to parse and extract accessible at the highest level via a 
# key named 'datasets', and the corresponding value is an array, a JSON array, of JSON
# subdocuments.
# 
# In Perl each subdocument is converted into a hash, and a key named 'name'
# contains the cellBrowser "dataset name"
# 
# There _may_ alos be key => value pairs:
# "body_parts": [
#    "brain"
#  ],
# etc. (see above)

# This is the list (array) of the 8 facets ("keys") we want to extract:
my @facets = qw/body_parts diseases organisms projects life_stages domains sources assays/;

# Iterating over the array of Perl hashes
foreach my $dataset ( @{$data->{datasets}} ) {
    # extracting the UCSC Cell Browser dataset name for the current dataset
    my $name = $dataset->{name};

    # iterating over the elements in the @facets array
    foreach my $facet ( @facets ) {
	# Test before attempting to extract the value:
	# Does this facet have an entry back in the original cellbrowser.conf file?
        if ( exists $dataset->{$facet} ) {
            # No call the subroutine that will add the term and the dataset name
	    # to the correct Global hash
            extract_facets( $name, $facet, $dataset );
        }
        else {
	    # When a dataset does not contain a particular facet, go test for the next one in the array
	    next;
        }
    } # close 2nd foreach;
} # close 1st foreach;

# Call the subroutine that prints out the Global hashes we created
# Each hash gets printed to a separate table
print_tables( \@facets );

sub extract_facets {
    my $name = $_[0];
    my $facet = $_[1];
    my $dataset = $_[2];

    my %dsc_of = (
        body_parts  => \%body_parts,
        diseases    => \%diseases,
        organisms   => \%organisms,
        projects    => \%projects,
        life_stages => \%life_stages,
        domains     => \%domains,
        sources     => \%sources,
        assays      => \%assays,
    );

    # Sometimes a facet key has MULTIPLE values
    # So we need to extract this information into
    # an array of values
    my @facet_list = @{ $dataset->{$facet} };

    # The Global hashes are actually hashes of array references
    # here the hash key is the _value_ from the JSON facet, and
    # the hash value we store is a an array of all the dataset
    # names that use this specific value (technicaly, an array reference)
    foreach my $value ( @facet_list ) {
        push( @{ ${$dsc_of{$facet}}{$value} }, $name );
    }
} # close sub


sub print_tables {
    my @facets = @{ $_[0] };

    my %dsc_of = (
        body_parts  => \%body_parts,
        diseases    => \%diseases,
        organisms   => \%organisms,
        projects    => \%projects,
        life_stages => \%life_stages,
        domains     => \%domains,
        sources     => \%sources,
        assays      => \%assays,
    );

    foreach my $facet ( @facets ) {
        my $out_file = $facet . '_table.tsv';
	open my ($FH), '>', $out_file or die "Could not open $out_file for writing: $!";
        my %hash = %{$dsc_of{$facet}};
        print $FH "term\tdataset_count\tdataset_names\n";
        foreach my $key ( sort keys %hash ) {
            print $FH "$key\t", scalar(@{$hash{$key}}), "\t", join(",", @{$hash{$key}}, ), "\n";
        } # close inner foreach	
        close $FH;
    } # close foreach loop

} # close sub
    

exit;

__END__




